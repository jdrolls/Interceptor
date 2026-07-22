/**
 * cli/commands/doctor.ts — `interceptor doctor [--json] [--fix]`
 *
 * Health preflight that surfaces browser-tooling degradation BEFORE a
 * verification run, instead of discovering it mid-verification (issue #880).
 * Checks daemon liveness, extension reachability, tab accumulation, and a
 * recent-timeout cluster (the documented degradation signature). `--fix`
 * restarts a degraded daemon (operator-invokable self-heal).
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { PID_PATH, SOCKET_PATH } from "../../shared/platform"
import { sendCommand } from "../transport"
import { ensureDaemon } from "../daemon-spawn"

const EVENTS_PATH = "/tmp/interceptor-events.jsonl"
const TAB_ACCUMULATION_LIMIT = 8

type Check = { name: string; ok: boolean; detail: string }
type DoctorEvent = { timestamp?: string; error?: string; event?: string }

/**
 * Pure degradation detector: counts events whose `error` contains "timeout"
 * (case-insensitive) within the last `windowMs`, and reports `degraded` once
 * that count reaches `threshold`. Extracted as a pure function so it is
 * testable without a live daemon or browser.
 */
export function detectRecentTimeouts(
  events: DoctorEvent[],
  now: number,
  windowMs = 60_000,
  threshold = 3
): { degraded: boolean; count: number } {
  let count = 0
  for (const ev of events) {
    if (!ev || typeof ev.error !== "string") continue
    if (!ev.error.toLowerCase().includes("timeout")) continue
    if (ev.timestamp) {
      const t = new Date(ev.timestamp).getTime()
      if (!Number.isNaN(t) && t < now - windowMs) continue
    }
    count++
  }
  return { degraded: count >= threshold, count }
}

function isDaemonAlive(): { alive: boolean; pid?: number } {
  if (!existsSync(PID_PATH)) return { alive: false }
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim().split("\n")[0])
    if (Number.isNaN(pid)) return { alive: false }
    try { process.kill(pid, 0); return { alive: true, pid } } catch { return { alive: false, pid } }
  } catch {
    return { alive: false }
  }
}

async function probeExtension(): Promise<{ ok: boolean; tabCount: number; detail: string }> {
  try {
    const resp = await Promise.race([
      sendCommand({ type: "tab_list" }, undefined),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("probe timed out after 2s")), 2000)
      ),
    ])
    const result = resp.result
    if (!result.success) return { ok: false, tabCount: 0, detail: result.error || "tab_list failed" }
    const tabs = Array.isArray(result.data) ? (result.data as unknown[]) : []
    if (tabs.length === 0) {
      return { ok: false, tabCount: 0, detail: "no tabs in interceptor group; run 'interceptor open <url>'" }
    }
    return { ok: true, tabCount: tabs.length, detail: `${tabs.length} tab(s) reachable` }
  } catch (err) {
    return { ok: false, tabCount: 0, detail: (err as Error).message }
  }
}

function readEvents(): DoctorEvent[] {
  if (!existsSync(EVENTS_PATH)) return []
  try {
    const content = readFileSync(EVENTS_PATH, "utf-8").trim()
    if (!content) return []
    const out: DoctorEvent[] = []
    for (const line of content.split("\n")) {
      try { out.push(JSON.parse(line)) } catch { /* ignore malformed line */ }
    }
    return out
  } catch {
    return []
  }
}

async function runChecks(): Promise<Check[]> {
  const checks: Check[] = []

  const daemon = isDaemonAlive()
  checks.push({
    name: "daemon",
    ok: daemon.alive,
    detail: daemon.alive ? `alive (pid ${daemon.pid})` : "not running",
  })

  checks.push({
    name: "socket",
    ok: existsSync(SOCKET_PATH),
    detail: existsSync(SOCKET_PATH) ? SOCKET_PATH : `${SOCKET_PATH} not found`,
  })

  // Extension + tab checks only make sense when the daemon is up.
  if (daemon.alive) {
    const probe = await probeExtension()
    checks.push({ name: "extension", ok: probe.ok, detail: probe.detail })
    if (probe.ok) {
      const overLimit = probe.tabCount > TAB_ACCUMULATION_LIMIT
      checks.push({
        name: "tabs",
        ok: !overLimit,
        detail: overLimit
          ? `${probe.tabCount} tabs accumulated — restart or close stale tabs (routing drifts past ~${TAB_ACCUMULATION_LIMIT})`
          : `${probe.tabCount} tab(s)`,
      })
    }
  } else {
    checks.push({ name: "extension", ok: false, detail: "skipped — daemon not running" })
  }

  const timeouts = detectRecentTimeouts(readEvents(), Date.now())
  checks.push({
    name: "timeouts",
    ok: !timeouts.degraded,
    detail: timeouts.degraded
      ? `${timeouts.count} timeout(s) in last 60s — daemon/extension degraded`
      : `${timeouts.count} recent timeout(s)`,
  })

  return checks
}

function report(checks: Check[], jsonMode: boolean): boolean {
  const degraded = checks.some(c => !c.ok)
  if (jsonMode) {
    console.log(JSON.stringify({ ok: !degraded, degraded, checks }, null, 2))
  } else {
    for (const c of checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
    }
    const failCount = checks.filter(c => !c.ok).length
    console.log(degraded ? `DEGRADED (${failCount} issue${failCount === 1 ? "" : "s"})` : "OK")
  }
  return degraded
}

function restartDaemon(): void {
  const daemon = isDaemonAlive()
  if (daemon.pid !== undefined) {
    try { process.kill(daemon.pid, "SIGTERM") } catch { /* already gone */ }
  }
  try { unlinkSync(SOCKET_PATH) } catch { /* fine */ }
  try { unlinkSync(PID_PATH) } catch { /* fine */ }
}

export async function runDoctorCommand(filtered: string[], opts: { jsonMode: boolean }): Promise<void> {
  const doFix = filtered.includes("--fix")

  let checks = await runChecks()
  let degraded = report(checks, opts.jsonMode)

  if (degraded && doFix) {
    process.stderr.write("→ restarting daemon...\n")
    restartDaemon()
    try {
      await ensureDaemon()
    } catch (err) {
      process.stderr.write(`daemon restart failed: ${(err as Error).message}\n`)
    }
    process.stderr.write("→ re-checking after restart...\n")
    checks = await runChecks()
    degraded = report(checks, opts.jsonMode)
  }

  process.exit(degraded ? 1 : 0)
}
