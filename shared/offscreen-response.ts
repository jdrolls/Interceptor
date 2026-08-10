/**
 * shared/offscreen-response.ts — normalize replies from the offscreen document.
 *
 * `chrome.runtime.sendMessage` invokes its callback with `undefined` whenever
 * nothing answered: the offscreen document was closed, it was created but its
 * listener had not registered yet, or the message matched no `case`. The old
 * `sendToOffscreen` resolved that `undefined` straight through to callers that
 * immediately read `.success` — so a missing offscreen document surfaced to the
 * operator as `Cannot read properties of undefined (reading 'success')`, a
 * TypeError that names neither the operation nor the cause (dora-cc#1377 ask 3).
 *
 * Pure so it can be tested without a `chrome` global.
 */

export type OffscreenResponse = {
  success: boolean
  data?: unknown
  error?: string
}

/**
 * Coerce any raw sendMessage reply into an `OffscreenResponse`, folding
 * `chrome.runtime.lastError` into the message when the reply was empty.
 */
export function normalizeOffscreenResponse(
  raw: unknown,
  operation: string,
  lastError?: string | null
): OffscreenResponse {
  if (raw === undefined || raw === null) {
    const cause = lastError
      ? lastError
      : "no listener replied (offscreen document closed, or created but not yet listening)"
    return { success: false, error: `offscreen '${operation}' did not respond: ${cause}` }
  }

  if (typeof raw === "object" && typeof (raw as { success?: unknown }).success === "boolean") {
    return raw as OffscreenResponse
  }

  let rendered: string
  try {
    rendered = JSON.stringify(raw)
  } catch {
    rendered = String(raw)
  }
  return { success: false, error: `offscreen '${operation}' returned a malformed response: ${rendered}` }
}
