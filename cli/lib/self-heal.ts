import { ensureDaemon } from "../daemon-spawn"
import { sendCommand, sendCommandWs, type Action, type DaemonResponse } from "../transport"
import { detectRecentTimeouts, readEvents, restartDaemon, waitForExtension } from "./daemon-health"

export const RETRYABLE_ACTIONS: ReadonlySet<string> = new Set([
  "get_state", "get_a11y_tree", "extract_text", "extract_html", "query", "query_one",
  "attr_get", "style_get", "forms", "links", "images", "meta", "storage_read",
  "clipboard_read", "selection_get", "rect", "exists", "count", "table_data",
  "page_info", "find_element", "modals", "panels", "what_at", "regions", "get_focus",
  "semantic_resolve", "wait", "wait_for", "wait_stable", "frames_list", "frames_read_tree",
  "tab_list", "tab_zoom_get", "window_list", "window_get_all", "cookies_get",
  "history_search", "history_visits", "bookmark_tree", "bookmark_search", "downloads_search",
  "session_list", "search_query", "net_log", "net_headers", "sse_log", "sse_streams",
  "sse_chunk", "network_log", "canvas_list", "canvas_read", "canvas_status", "canvas_log",
  "canvas_objects", "canvas_model", "canvas_routes", "canvas_ocr", "screenshot",
  "screenshot_background", "page_capture", "scene_list", "scene_hit", "scene_selected",
  "scene_text", "scene_slide_list", "scene_slide_current", "scene_notes", "scene_render",
  "scene_profile", "monitor_status"
])

let healed = false

export function isRetryableAction(type: string): boolean {
  return RETRYABLE_ACTIONS.has(type)
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("timeout: no response for")
}

export function selfHealEnabled(env = process.env): boolean {
  const value = env.INTERCEPTOR_NO_AUTOHEAL?.toLowerCase()
  return value !== "1" && value !== "true"
}

export type RecoveryDecision = "rethrow" | "heal-and-retry" | "heal-and-fail"

export function decideRecovery(opts: {
  isTimeout: boolean
  enabled: boolean
  degraded: boolean
  alreadyHealed: boolean
  retryable: boolean
}): RecoveryDecision {
  if (!opts.isTimeout || !opts.enabled || !opts.degraded || opts.alreadyHealed) return "rethrow"
  return opts.retryable ? "heal-and-retry" : "heal-and-fail"
}

function send(action: Action, tabId: number | undefined, useWs: boolean): Promise<DaemonResponse> {
  return useWs ? sendCommandWs(action, tabId) : sendCommand(action, tabId)
}

export async function sendWithRecovery(
  action: Action,
  tabId: number | undefined,
  useWs: boolean
): Promise<DaemonResponse> {
  try {
    return await send(action, tabId, useWs)
  } catch (err) {
    if (!isTimeoutError(err) || !selfHealEnabled()) throw err

    const timeouts = detectRecentTimeouts(readEvents(), Date.now())
    const decision = decideRecovery({
      isTimeout: true,
      enabled: true,
      degraded: timeouts.degraded,
      alreadyHealed: healed,
      retryable: isRetryableAction(action.type)
    })
    if (decision === "rethrow") throw err

    healed = true
    process.stderr.write(`⚠ interceptor: degraded (${timeouts.count} timeouts in 60s) — self-healing: restarting daemon…\n`)
    try {
      restartDaemon()
      await ensureDaemon()
      await waitForExtension()
    } catch (healErr) {
      process.stderr.write(`⚠ interceptor: self-heal failed: ${(healErr as Error).message}\n`)
      throw err
    }

    if (decision === "heal-and-retry") {
      process.stderr.write(`↻ interceptor: retrying '${action.type}' after self-heal\n`)
      return send(action, tabId, useWs)
    }

    throw new Error(`${(err as Error).message} — daemon was degraded and has been restarted (self-heal); re-run this command. Set INTERCEPTOR_NO_AUTOHEAL=1 to disable.`)
  }
}
