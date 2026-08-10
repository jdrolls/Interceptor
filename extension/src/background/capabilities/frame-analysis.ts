/**
 * extension/src/background/capabilities/frame-analysis.ts — flag captures that
 * contain no picture.
 *
 * Runs in the service worker rather than the offscreen document: MV3 workers
 * have `createImageBitmap` + `OffscreenCanvas`, so the check needs no extra
 * document, no extra round trip, and no capture-stream lifecycle to respect.
 *
 * Decode failures are NEVER converted into a blank verdict. A frame we could
 * not read is unknown, not black — inventing "blank" from a decode error would
 * reintroduce exactly the false-negative class this exists to kill
 * (dora-cc#1377 ask 4).
 */

import { analyzeLuma, classifyBlankFrame, type BlankVerdict } from "../../../../shared/frame-analysis"

/** Longest edge the frame is downsampled to before the luma pass. */
export const ANALYSIS_MAX_EDGE = 256

/**
 * Hard ceiling on the check itself. Screenshots already run under an absolute
 * 12s budget beneath the CLI's 15s WebSocket ceiling; a diagnostic bolted onto
 * the end of that must not be able to spend the remaining margin decoding a
 * 20MB full-page stitch. Over budget, the frame goes back unannotated —
 * unknown, not blank.
 */
export const ANALYSIS_BUDGET_MS = 1_500

function withBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>(resolve => setTimeout(() => resolve(null), ms)),
  ])
}

export type BlankAnnotation = {
  blank: boolean
  kind: BlankVerdict["kind"]
  reason: string
  stats: BlankVerdict["stats"]
}

/**
 * Decode a data URL and classify it. Returns null when the frame could not be
 * decoded or measured — an unknown frame, deliberately not a blank one.
 */
export async function inspectDataUrl(dataUrl: string): Promise<BlankAnnotation | null> {
  try {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null
    const blob = await (await fetch(dataUrl)).blob()
    const bitmap = await createImageBitmap(blob)
    try {
      const scale = Math.min(1, ANALYSIS_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null
      if (!ctx) return null
      ctx.drawImage(bitmap, 0, 0, width, height)
      const verdict = classifyBlankFrame(analyzeLuma(ctx.getImageData(0, 0, width, height).data))
      return { blank: verdict.blank, kind: verdict.kind, reason: verdict.reason, stats: verdict.stats }
    } finally {
      bitmap.close()
    }
  } catch {
    return null
  }
}

type AnnotatableResult = {
  success: boolean
  error?: string
  data?: unknown
  [key: string]: unknown
}

/**
 * Attach a `blank` verdict to any successful result carrying a `dataUrl`.
 *
 * The result is still returned — the caller may genuinely want a black frame —
 * but it can no longer pass for evidence silently: `blank.blank` is true and
 * `blank.reason` names the occluded-window cause, and the CLI prints it.
 */
export async function annotateBlankFrame<T extends AnnotatableResult>(result: T): Promise<T> {
  if (!result?.success) return result
  const data = result.data
  if (!data || typeof data !== "object") return result
  const dataUrl = (data as { dataUrl?: unknown }).dataUrl
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return result

  const annotation = await withBudget(inspectDataUrl(dataUrl), ANALYSIS_BUDGET_MS)
  if (!annotation) return result
  return { ...result, data: { ...(data as Record<string, unknown>), blank: annotation } }
}
