import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { EVENTS_PATH, PID_PATH, SOCKET_PATH } from "../../shared/platform"
import { sendCommand } from "../transport"

export const TAB_ACCUMULATION_LIMIT = 8

export type DoctorEvent = { timestamp?: string; error?: string; event?: string }
export type ProbedTab = { managed?: boolean }

export function countManagedTabs(tabs: ProbedTab[]): number {
  return tabs.filter(tab => tab.managed === true).length
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

export function restartDaemon(): void {
  const daemon = isDaemonAlive()
  if (daemon.pid !== undefined) {
    try { process.kill(daemon.pid, "SIGTERM") } catch { /* already gone */ }
  }
  try { unlinkSync(SOCKET_PATH) } catch { /* fine */ }
  try { unlinkSync(PID_PATH) } catch { /* fine */ }
}
