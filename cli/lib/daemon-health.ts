import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { EVENTS_PATH, PID_PATH, SOCKET_PATH, WS_PORT } from "../../shared/platform"
import { sendCommand } from "../transport"

export const TAB_ACCUMULATION_LIMIT = 8

export type DoctorEvent = { timestamp?: string; error?: string; event?: string; requestId?: string }
export type ProbedTab = { managed?: boolean }

export function countManagedTabs(tabs: ProbedTab[]): number {
  return tabs.filter(tab => tab.managed === true).length
}

/** The pid listening on the WebSocket port, or null when it cannot be found. */
export async function findWsPortOwner(port = WS_PORT): Promise<number | null> {
  try {
    const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    const first = output.trim().split(/\s+/)[0]
    const pid = Number.parseInt(first, 10)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** All process ids whose command line identifies an interceptor daemon. */
export async function findDaemonPids(): Promise<number[]> {
  try {
    const proc = Bun.spawn(["pgrep", "-f", "interceptor-daemon"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return [...new Set(output.split(/\s+/)
      .map(value => Number.parseInt(value, 10))
      .filter(pid => Number.isSafeInteger(pid) && pid > 0))]
  } catch {
    return []
  }
}

export function detectSplitBrain(opts: {
  daemonPid: number | null
  wsOwnerPid: number | null
  extensionOk: boolean
  daemonPids: number[]
}): { split: boolean; detail: string } {
  const { daemonPid, wsOwnerPid, extensionOk, daemonPids } = opts
  if (extensionOk || wsOwnerPid === null || wsOwnerPid === daemonPid) {
    return { split: false, detail: "no daemon split-brain detected" }
  }

  // From the CLI daemon's perspective, every other daemon is an orphan. This
  // includes the WS owner, which is serving the extension but not this socket.
  const orphanCount = daemonPids.filter(pid => pid !== daemonPid).length
  const cliOwner = daemonPid === null ? "missing pidfile daemon" : `pid ${daemonPid}`
  return {
    split: true,
    detail: `extension is served by daemon pid ${wsOwnerPid} but the CLI socket is owned by ${cliOwner}; ${orphanCount} orphaned daemon(s)`,
  }
}

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
  const requestIds = new Set<string>()
  for (const ev of events) {
    if (!ev) continue
    const isTimeout = (typeof ev.error === "string" && ev.error.toLowerCase().includes("timeout")) || ev.event === "request_timeout" || ev.event === "request_abandoned"
    if (!isTimeout) continue
    if (ev.timestamp) {
      const t = new Date(ev.timestamp).getTime()
      if (!Number.isNaN(t) && t < now - windowMs) continue
    }
    if (ev.requestId) {
      if (requestIds.has(ev.requestId)) continue
      requestIds.add(ev.requestId)
    }
    count++
  }
  return { degraded: count >= threshold, count }
}

export async function getDaemonStatus(): Promise<{ extensionConnected: boolean } | null> {
  try {
    // Bound this the way probeExtension is. `daemon_status` is answered by the daemon
    // itself, so a healthy one replies immediately — but an OLDER daemon that predates
    // the action forwards it to the extension instead, where it would hang for the full
    // CLI ceiling and log a spurious timeout. During a CLI/daemon version skew the
    // preflight must stay fast and must not pollute the degradation detector.
    const resp = await Promise.race([
      sendCommand({ type: "daemon_status" }, undefined),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("daemon_status timed out after 2s")), 2000)
      ),
    ])
    if (!resp.result.success || !resp.result.data || typeof resp.result.data !== "object") return null
    const { extensionConnected } = resp.result.data as { extensionConnected?: unknown }
    return typeof extensionConnected === "boolean" ? { extensionConnected } : null
  } catch {
    return null
  }
}

export function isDaemonAlive(): { alive: boolean; pid?: number } {
  if (!existsSync(PID_PATH)) return { alive: false }
  try {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim().split("\n")[0])
    if (Number.isNaN(pid)) return { alive: false }
    try { process.kill(pid, 0); return { alive: true, pid } } catch { return { alive: false, pid } }
  } catch {
    return { alive: false }
  }
}

export async function probeExtension(): Promise<{ ok: boolean; tabCount: number; managedTabCount: number; detail: string }> {
  try {
    const resp = await Promise.race([
      sendCommand({ type: "tab_list" }, undefined),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("probe timed out after 2s")), 2000)
      ),
    ])
    const result = resp.result
    if (!result.success) return { ok: false, tabCount: 0, managedTabCount: 0, detail: result.error || "tab_list failed" }
    const tabs = Array.isArray(result.data) ? (result.data as ProbedTab[]) : []
    if (tabs.length === 0) {
      return { ok: false, tabCount: 0, managedTabCount: 0, detail: "no tabs in interceptor group; run 'interceptor open <url>'" }
    }
    return { ok: true, tabCount: tabs.length, managedTabCount: countManagedTabs(tabs), detail: `${tabs.length} tab(s) reachable` }
  } catch (err) {
    return { ok: false, tabCount: 0, managedTabCount: 0, detail: (err as Error).message }
  }
}

export function readEvents(): DoctorEvent[] {
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
export async function waitForExtension(maxMs = 10_000, intervalMs = 500): Promise<void> {
  const until = Date.now() + maxMs
  while (Date.now() < until) {
    if ((await probeExtension()).ok) return
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

async function waitForPidsToExit(pids: number[], timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const anyAlive = pids.some(pid => {
      try { process.kill(pid, 0); return true } catch { return false }
    })
    if (!anyAlive) return
    await Bun.sleep(50)
  }
}

/** Reap every daemon identity before starting a replacement. */
export async function restartDaemon(): Promise<void> {
  const daemon = isDaemonAlive()
  const wsOwner = await findWsPortOwner()
  const daemonPids = await findDaemonPids()
  const pids = [...new Set([
    ...(daemon.pid === undefined ? [] : [daemon.pid]),
    ...(wsOwner === null ? [] : [wsOwner]),
    ...daemonPids,
  ])]

  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM") } catch { /* already gone or inaccessible */ }
  }
  await waitForPidsToExit(pids)
  try { unlinkSync(SOCKET_PATH) } catch { /* fine */ }
  try { unlinkSync(PID_PATH) } catch { /* fine */ }
}
