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
import { EVENTS_PATH, PID_PATH, SOCKET_PATH } from "../../shared/platform"
import { sendCommand } from "../transport"
import { ensureDaemon } from "../daemon-spawn"

const TAB_ACCUMULATION_LIMIT = 8

type Check = { name: string; ok: boolean; detail: string }
type DoctorEvent = { timestamp?: string; error?: string; event?: string }

/**
 * The daemon historically recorded only request lifecycle events, leaving
 * doctor blind to client-side timeouts. Count explicit timeout events too,
 * while retaining compatibility with legacy error-bearing entries.
 */
export function detectRecentTimeouts(
  events: DoctorEvent[],
  now: number,
  windowMs = 60_000,
  threshold = 3
): { degraded: boolean; count: number } {
  let count = 0
  for (const ev of events) {
    if (!ev) continue
    const isTimeout = (typeof ev.error === "string" && ev.error.toLowerCase().includes("timeout")) || ev.event === "request_timeout"
    if (!isTimeout) continue
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

/**
 * A restarted daemon is reachable before the extension has re-established its
 * WebSocket to it (measured: ~2s). Re-checking immediately therefore reports a
 * SUCCESSFUL self-heal as a failed one, which is worse than not healing at all
 * for anything automating on the exit code. Poll instead of guessing a sleep.
 */
async function waitForExtension(maxMs = 10_000, intervalMs = 500): Promise<void> {
  const until = Date.now() + maxMs
  while (Date.now() < until) {
    if ((await probeExtension()).ok) return
    await new Promise(r => setTimeout(r, intervalMs))
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
    await waitForExtension()
    process.stderr.write("→ re-checking after restart...\n")
    checks = await runChecks()
    degraded = report(checks, opts.jsonMode)
  }

  process.exit(degraded ? 1 : 0)
}
