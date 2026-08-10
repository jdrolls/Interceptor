/**
 * shared/frame-analysis.ts — decide whether a captured frame actually contains
 * a picture of anything.
 *
 * macOS does not paint an occluded window. Ask for a capture of a managed
 * browser window that is behind another window (or on another Space) and the
 * compositor hands back a fully-formed, correctly-sized, entirely BLACK image.
 * Every layer below this one reports success, because every layer below this
 * one did succeed — the bytes are a valid PNG. The failure only exists at the
 * level of "is this evidence?", so that is the level that has to test for it
 * (dora-cc#1377 ask 4; ~10 tool calls of false-negative debugging).
 *
 * Pure functions over raw RGBA so the thresholds can be tested without a
 * browser, a canvas, or a Mac.
 */

export type LumaStats = {
  sampledPixels: number
  meanLuma: number
  minLuma: number
  maxLuma: number
  nonBlackPixels: number
  nonBlackFraction: number
}

/** Rec.709 luma of a single pixel, 0-255. */
export function pixelLuma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** A pixel brighter than this counts as "painted". Compression noise on a
 *  genuinely black frame stays well under it. */
export const BLACK_PIXEL_LUMA = 8

/** Below this share of painted pixels the frame carries no usable evidence. */
export const MIN_NON_BLACK_FRACTION = 0.002

/** Peak-to-trough spread under this means every pixel is the same colour. */
export const UNIFORM_LUMA_SPREAD = 2

/**
 * Reduce raw RGBA bytes to luma statistics. `stride` samples every Nth pixel;
 * the caller downsamples the image first, so the default of 1 is honest.
 *
 * Alpha is deliberately ignored: an occluded-window capture comes back opaque
 * black, not transparent, so keying on alpha would miss the exact case this
 * exists for.
 */
export function analyzeLuma(rgba: ArrayLike<number>, opts: { stride?: number } = {}): LumaStats {
  const stride = Math.max(1, Math.floor(opts.stride ?? 1))
  const step = 4 * stride

  let sampled = 0
  let total = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let nonBlack = 0

  for (let i = 0; i + 2 < rgba.length; i += step) {
    const luma = pixelLuma(rgba[i], rgba[i + 1], rgba[i + 2])
    sampled++
    total += luma
    if (luma < min) min = luma
    if (luma > max) max = luma
    if (luma > BLACK_PIXEL_LUMA) nonBlack++
  }

  if (sampled === 0) {
    return { sampledPixels: 0, meanLuma: 0, minLuma: 0, maxLuma: 0, nonBlackPixels: 0, nonBlackFraction: 0 }
  }

  return {
    sampledPixels: sampled,
    meanLuma: total / sampled,
    minLuma: min,
    maxLuma: max,
    nonBlackPixels: nonBlack,
    nonBlackFraction: nonBlack / sampled,
  }
}

export type BlankVerdict = {
  blank: boolean
  kind: "black" | "uniform" | "empty" | null
  reason: string
  stats: LumaStats
}

const round = (n: number) => Math.round(n * 100) / 100

/**
 * Classify a frame from its luma statistics.
 *
 * "black" is the occluded-window signature and the one that matters. "uniform"
 * catches its cousins — a capture of a blank white page or a solid splash
 * colour — which are equally worthless as verification evidence and equally
 * easy to mistake for a real screenshot.
 */
export function classifyBlankFrame(stats: LumaStats): BlankVerdict {
  if (stats.sampledPixels === 0) {
    return { blank: true, kind: "empty", reason: "capture contained no pixels", stats }
  }
  if (stats.maxLuma <= BLACK_PIXEL_LUMA) {
    return {
      blank: true,
      kind: "black",
      reason:
        `all-black capture (brightest pixel luma ${round(stats.maxLuma)} ≤ ${BLACK_PIXEL_LUMA}) — ` +
        "macOS returns black for an occluded or off-Space window; raise the window and re-capture",
      stats,
    }
  }
  if (stats.nonBlackFraction < MIN_NON_BLACK_FRACTION) {
    return {
      blank: true,
      kind: "black",
      reason:
        `near-black capture (${round(stats.nonBlackFraction * 100)}% of pixels painted, ` +
        `below the ${round(MIN_NON_BLACK_FRACTION * 100)}% floor) — ` +
        "macOS returns black for an occluded or off-Space window; raise the window and re-capture",
      stats,
    }
  }
  if (stats.maxLuma - stats.minLuma <= UNIFORM_LUMA_SPREAD) {
    return {
      blank: true,
      kind: "uniform",
      reason:
        `uniform capture (luma spread ${round(stats.maxLuma - stats.minLuma)} ≤ ${UNIFORM_LUMA_SPREAD}) — ` +
        "every pixel is the same colour; the page probably had not painted yet",
      stats,
    }
  }
  return { blank: false, kind: null, reason: "frame contains rendered content", stats }
}

/** One-line operator-facing warning for a blank verdict. */
export function blankFrameWarning(verdict: Pick<BlankVerdict, "kind" | "reason">): string {
  return `blank capture (${verdict.kind}): ${verdict.reason}`
}

/**
 * Pull the warning out of a capture result payload, or null when the payload
 * carries no blank verdict or a non-blank one. Used by the CLI so a blank frame
 * reaches the operator on stderr rather than only inside the JSON body.
 */
export function extractBlankWarning(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const blank = (data as { blank?: unknown }).blank
  if (!blank || typeof blank !== "object") return null
  const { blank: isBlank, kind, reason } = blank as { blank?: unknown; kind?: unknown; reason?: unknown }
  if (isBlank !== true) return null
  return blankFrameWarning({
    kind: (typeof kind === "string" ? kind : null) as BlankVerdict["kind"],
    reason: typeof reason === "string" ? reason : "no reason recorded",
  })
}
