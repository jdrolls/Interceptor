/**
 * test/frame-analysis.test.ts — dora-cc#1377 ask 4.
 *
 * The occluded-window failure returns a structurally perfect image whose every
 * pixel is black. These tests pin the thresholds that separate "no picture"
 * from "a dark picture" — the latter must keep passing, or the check would
 * simply trade a false negative for a false positive.
 */

import { describe, expect, test } from "bun:test"
import {
  analyzeLuma,
  blankFrameWarning,
  classifyBlankFrame,
  extractBlankWarning,
  pixelLuma,
  BLACK_PIXEL_LUMA,
} from "../shared/frame-analysis"
import { normalizeOffscreenResponse } from "../shared/offscreen-response"

/** Build RGBA bytes from a per-pixel colour function. */
function frame(count: number, color: (i: number) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(count * 4)
  for (let i = 0; i < count; i++) {
    const [r, g, b] = color(i)
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = 255
  }
  return out
}

const solid = (count: number, r: number, g: number, b: number) => frame(count, () => [r, g, b])

describe("analyzeLuma", () => {
  test("measures a solid black frame", () => {
    const stats = analyzeLuma(solid(100, 0, 0, 0))
    expect(stats.sampledPixels).toBe(100)
    expect(stats.meanLuma).toBe(0)
    expect(stats.maxLuma).toBe(0)
    expect(stats.nonBlackFraction).toBe(0)
  })

  test("measures a solid white frame", () => {
    const stats = analyzeLuma(solid(100, 255, 255, 255))
    expect(Math.round(stats.meanLuma)).toBe(255)
    expect(stats.nonBlackFraction).toBe(1)
  })

  test("stride samples every Nth pixel", () => {
    expect(analyzeLuma(solid(100, 10, 10, 10), { stride: 10 }).sampledPixels).toBe(10)
  })

  test("empty input yields a zeroed, non-NaN result", () => {
    const stats = analyzeLuma(new Uint8ClampedArray(0))
    expect(stats.sampledPixels).toBe(0)
    expect(Number.isNaN(stats.meanLuma)).toBe(false)
  })

  test("luma is Rec.709 weighted — green dominates", () => {
    expect(pixelLuma(0, 255, 0)).toBeGreaterThan(pixelLuma(255, 0, 0))
    expect(pixelLuma(255, 0, 0)).toBeGreaterThan(pixelLuma(0, 0, 255))
  })
})

describe("classifyBlankFrame", () => {
  test("an all-black frame is blank, kind 'black', and blames occlusion", () => {
    const v = classifyBlankFrame(analyzeLuma(solid(1000, 0, 0, 0)))
    expect(v.blank).toBe(true)
    expect(v.kind).toBe("black")
    expect(v.reason).toContain("occluded")
  })

  test("black with JPEG noise under the luma floor is still blank", () => {
    const noisy = frame(1000, i => [i % 3, i % 2, 0]) // every pixel luma < BLACK_PIXEL_LUMA
    const stats = analyzeLuma(noisy)
    expect(stats.maxLuma).toBeLessThanOrEqual(BLACK_PIXEL_LUMA)
    expect(classifyBlankFrame(stats).blank).toBe(true)
  })

  test("a mostly-black frame with a handful of bright pixels is still blank", () => {
    // 1 painted pixel in 10_000 — below the 0.2% floor.
    const almost = frame(10_000, i => (i === 0 ? [255, 255, 255] : [0, 0, 0]))
    const v = classifyBlankFrame(analyzeLuma(almost))
    expect(v.blank).toBe(true)
    expect(v.kind).toBe("black")
  })

  test("a genuinely dark page is NOT blank — dark mode must keep passing", () => {
    // Every pixel painted at luma ~30: dark, but real content.
    const darkMode = frame(1000, i => (i % 2 === 0 ? [30, 30, 30] : [40, 40, 45]))
    const v = classifyBlankFrame(analyzeLuma(darkMode))
    expect(v.blank).toBe(false)
    expect(v.kind).toBeNull()
  })

  test("a solid white frame is blank with kind 'uniform', not 'black'", () => {
    const v = classifyBlankFrame(analyzeLuma(solid(1000, 255, 255, 255)))
    expect(v.blank).toBe(true)
    expect(v.kind).toBe("uniform")
  })

  test("a normal screenshot is not blank", () => {
    const page = frame(1000, i => [(i * 7) % 256, (i * 13) % 256, (i * 29) % 256])
    expect(classifyBlankFrame(analyzeLuma(page)).blank).toBe(false)
  })

  test("a zero-pixel capture is blank with kind 'empty'", () => {
    const v = classifyBlankFrame(analyzeLuma(new Uint8ClampedArray(0)))
    expect(v.blank).toBe(true)
    expect(v.kind).toBe("empty")
  })

  test("the warning line names the kind and the reason", () => {
    const v = classifyBlankFrame(analyzeLuma(solid(100, 0, 0, 0)))
    expect(blankFrameWarning(v)).toContain("blank capture (black)")
    expect(blankFrameWarning(v)).toContain("re-capture")
  })
})

describe("extractBlankWarning", () => {
  test("returns a warning for a flagged payload", () => {
    const warning = extractBlankWarning({
      dataUrl: "data:image/png;base64,AAA",
      blank: { blank: true, kind: "black", reason: "all-black capture" },
    })
    expect(warning).toContain("blank capture (black)")
    expect(warning).toContain("all-black capture")
  })

  test("returns null for a healthy capture, a missing verdict, or a non-object", () => {
    expect(extractBlankWarning({ blank: { blank: false, kind: null, reason: "fine" } })).toBeNull()
    expect(extractBlankWarning({ dataUrl: "data:image/png;base64,AAA" })).toBeNull()
    expect(extractBlankWarning(null)).toBeNull()
    expect(extractBlankWarning("nope")).toBeNull()
  })
})

describe("normalizeOffscreenResponse", () => {
  test("an undefined reply becomes a named failure, not a TypeError source", () => {
    const r = normalizeOffscreenResponse(undefined, "capture_frame")
    expect(r.success).toBe(false)
    expect(r.error).toContain("capture_frame")
    // The old behaviour: callers read `.success` off undefined and blew up with
    // "Cannot read properties of undefined (reading 'success')".
    expect(() => r.success).not.toThrow()
  })

  test("chrome.runtime.lastError is carried into the message", () => {
    const r = normalizeOffscreenResponse(undefined, "capture_frame", "Could not establish connection.")
    expect(r.error).toContain("Could not establish connection.")
  })

  test("a well-formed reply passes through untouched", () => {
    const ok = { success: true, data: "data:image/png;base64,AAA" }
    expect(normalizeOffscreenResponse(ok, "capture_frame")).toBe(ok)
    const err = { success: false, error: "no active capture" }
    expect(normalizeOffscreenResponse(err, "capture_frame")).toBe(err)
  })

  test("a malformed reply is reported as malformed rather than trusted", () => {
    const r = normalizeOffscreenResponse({ nope: 1 }, "crop")
    expect(r.success).toBe(false)
    expect(r.error).toContain("malformed")
    expect(r.error).toContain("crop")
  })
})
