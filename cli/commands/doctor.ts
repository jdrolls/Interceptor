/**
 * cli/commands/doctor.ts — `interceptor doctor [--json] [--fix]`
 *
 * Health preflight that surfaces browser-tooling degradation BEFORE a
 * verification run, instead of discovering it mid-verification (issue #880).
 * Checks daemon liveness, extension reachability, tab accumulation, and a
 * recent-timeout cluster (the documented degradation signature). `--fix`
 * restarts a degraded daemon (operator-invokable self-heal).
 */

import { existsSync } from "node:fs"
import { SOCKET_PATH } from "../../shared/platform"
import { ensureDaemon } from "../daemon-spawn"
import {
  TAB_ACCUMULATION_LIMIT,
  detectRecentTimeouts,
  detectSplitBrain,
  findDaemonPids,
  findWsPortOwner,
  isDaemonAlive,
  probeExtension,
  readEvents,
  restartDaemon,
  waitForExtension
} from "../lib/daemon-health"

export { detectRecentTimeouts } from "../lib/daemon-health"

type Check = { name: string; ok: boolean; detail: string }

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
    if (!probe.ok) {
      const splitBrain = detectSplitBrain({
        daemonPid: daemon.pid ?? null,
        wsOwnerPid: await findWsPortOwner(),
        extensionOk: probe.ok,
        daemonPids: await findDaemonPids(),
      })
      checks.push({ name: "split-brain", ok: !splitBrain.split, detail: splitBrain.detail })
    }
    if (probe.ok) {
      const overLimit = probe.managedTabCount > TAB_ACCUMULATION_LIMIT
      checks.push({
        name: "tabs",
        ok: !overLimit,
        detail: overLimit
          ? `${probe.managedTabCount} interceptor tabs accumulated (${probe.tabCount} total) — close stale tabs (routing drifts past ~${TAB_ACCUMULATION_LIMIT})`
          : `${probe.managedTabCount} interceptor tab(s) (${probe.tabCount} total)`,
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

export async function runDoctorCommand(filtered: string[], opts: { jsonMode: boolean }): Promise<void> {
  const doFix = filtered.includes("--fix")

  let checks = await runChecks()
  let degraded = report(checks, opts.jsonMode)

  if (degraded && doFix) {
    process.stderr.write("→ restarting daemon...\n")
    await restartDaemon()
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
