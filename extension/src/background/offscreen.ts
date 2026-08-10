import { normalizeOffscreenResponse, type OffscreenResponse } from "../../../shared/offscreen-response"

export const OFFSCREEN_IDLE_MS = 30_000

let offscreenIdleTimer: ReturnType<typeof setTimeout> | null = null
/**
 * While pinned, the idle reaper never closes the offscreen document.
 *
 * `capture start` parks a live MediaStream inside that document. The reaper
 * used to tear it down 30s later regardless, so a `capture frame` after any
 * pause silently lost its stream — and the recreated document came back with
 * reason BLOBS, which cannot host getUserMedia at all (dora-cc#1377 ask 3).
 */
let offscreenPinned = false

type OffscreenReason = chrome.offscreen.Reason

async function offscreenExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType]
  })
  return contexts.length > 0
}

export async function ensureOffscreen(): Promise<void> {
  if (await offscreenExists()) {
    resetOffscreenTimer()
    return
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS" as OffscreenReason],
    justification: "Image crop, stitch, and diff operations"
  })
  resetOffscreenTimer()
}

/**
 * Recreate the offscreen document with USER_MEDIA and pin it.
 *
 * An offscreen document's `reasons` are fixed at creation, so a document that
 * already exists for BLOBS cannot start hosting a tab-capture stream — it has
 * to be closed and rebuilt. Doing that explicitly here is what makes
 * `capture start` deterministic instead of dependent on whichever image
 * operation happened to run first.
 */
export async function ensureOffscreenForCapture(): Promise<void> {
  if (await offscreenExists()) {
    try { await chrome.offscreen.closeDocument() } catch { /* already gone */ }
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA" as OffscreenReason],
    justification: "Tab capture stream processing"
  })
  pinOffscreen()
}

export function pinOffscreen(): void {
  offscreenPinned = true
  if (offscreenIdleTimer) {
    clearTimeout(offscreenIdleTimer)
    offscreenIdleTimer = null
  }
}

export function unpinOffscreen(): void {
  offscreenPinned = false
  resetOffscreenTimer()
}

export function resetOffscreenTimer(): void {
  if (offscreenPinned) return
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer)
  offscreenIdleTimer = setTimeout(async () => {
    try { await chrome.offscreen.closeDocument() } catch {}
    offscreenIdleTimer = null
  }, OFFSCREEN_IDLE_MS)
}

/**
 * Send a message to the offscreen document and ALWAYS resolve a structured
 * result.
 *
 * `chrome.runtime.sendMessage` calls back with `undefined` when nothing
 * answered; resolving that straight through is what turned "the offscreen
 * document was closed" into `Cannot read properties of undefined (reading
 * 'success')` at every call site (dora-cc#1377 ask 3).
 */
export async function sendToOffscreen(msg: Record<string, unknown>): Promise<OffscreenResponse> {
  const operation = String(msg.type ?? "unknown")
  await ensureOffscreen()
  return dispatch(msg, operation)
}

/**
 * `sendToOffscreen` for capture traffic: never recreates the document, because
 * recreating it is precisely what would destroy the stream being asked about.
 * A missing document here is a real error with a real instruction.
 */
export async function sendToCaptureOffscreen(msg: Record<string, unknown>): Promise<OffscreenResponse> {
  const operation = String(msg.type ?? "unknown")
  if (!(await offscreenExists())) {
    return {
      success: false,
      error: `offscreen '${operation}' has no capture session — run 'interceptor capture start' first`,
    }
  }
  return dispatch(msg, operation)
}

function dispatch(msg: Record<string, unknown>, operation: string): Promise<OffscreenResponse> {
  return new Promise<OffscreenResponse>((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: "offscreen" }, (raw: unknown) => {
      resolve(normalizeOffscreenResponse(raw, operation, chrome.runtime.lastError?.message ?? null))
    })
  })
}
