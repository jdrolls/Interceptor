/**
 * test/screenshot-contract.test.ts — the exit-0-false-evidence contract
 * (dora-cc#1383). Each block maps to one acceptance criterion in the issue.
 */

import { describe, expect, test } from "bun:test"
import {
  assertCaptureTarget,
  dataUrlBytes,
  extractLazyImageWarning,
  gateDataUrl,
  lazyImageWarning,
  reportLazyImages,
  validateScreenshotFlags,
} from "../shared/screenshot-contract"

// ── Acceptance 1: --pixel against a drifted tab refuses, eval-shaped ─────────

describe("assertCaptureTarget", () => {
  test("passes when the requested tab is the visible one", () => {
    const check = assertCaptureTarget({
      requestedTabId: 42,
      requestedTabUrl: "https://example.com/",
      visibleTabId: 42,
      visibleTabUrl: "https://example.com/",
      windowId: 7,
    })
    expect(check).toEqual({ ok: true, drifted: false })
  })

  test("refuses when captureVisibleTab would photograph a different tab", () => {
    const check = assertCaptureTarget({
      requestedTabId: 1957911780,
      requestedTabUrl: "https://blog.example.com/staged-post",
      visibleTabId: 1957911774,
      visibleTabUrl: "file:///tmp/lifeos-bench-report.html",
      windowId: 3,
    })
    expect(check.ok).toBe(false)
    if (check.ok) throw new Error("expected refusal")
    // Same message shape eval's tab-drift guard uses: both tab ids, the URL
    // that would have been captured, and every escape hatch.
    expect(check.error).toContain("1957911780")
    expect(check.error).toContain("1957911774")
    expect(check.error).toContain("file:///tmp/lifeos-bench-report.html")
    expect(check.error).toContain("refusing to silently capture")
    expect(check.error).toContain("--tab")
    expect(check.error).toContain("interceptor open <url>")
    expect(check.error).toContain("INTERCEPTOR_ALLOW_TAB_DRIFT=1")
  })

  test("INTERCEPTOR_ALLOW_TAB_DRIFT opts back in and names the tab really captured", () => {
    const check = assertCaptureTarget({
      requestedTabId: 10,
      requestedTabUrl: "https://a.example/",
      visibleTabId: 11,
      visibleTabUrl: "https://b.example/",
      allowTabDrift: true,
    })
    expect(check).toEqual({ ok: true, drifted: true, capturedTabId: 11, capturedTabUrl: "https://b.example/" })
  })

  test("refuses when the window reports no visible tab at all", () => {
    const check = assertCaptureTarget({ requestedTabId: 5, windowId: 9 })
    expect(check.ok).toBe(false)
    if (check.ok) throw new Error("expected refusal")
    expect(check.error).toContain("no visible tab")
  })

  test("a missing visible URL still refuses rather than passing", () => {
    const check = assertCaptureTarget({ requestedTabId: 1, visibleTabId: 2 })
    expect(check.ok).toBe(false)
    if (check.ok) throw new Error("expected refusal")
    expect(check.error).toContain("unknown URL")
  })
})

// ── Acceptance 3: unknown flags exit non-zero, naming the flag ───────────────

describe("validateScreenshotFlags", () => {
  test("--out is rejected by name with a pointer to --save", () => {
    const v = validateScreenshotFlags(["--format", "jpeg", "--target-max-long-edge", "200", "--out", "/tmp/x.png"])
    expect(v.ok).toBe(false)
    if (v.ok) throw new Error("expected rejection")
    expect(v.unknown).toEqual(["--out"])
    expect(v.error).toContain("--out")
    expect(v.error).toContain("--save")
  })

  test("every implemented flag passes", () => {
    expect(validateScreenshotFlags([
      "--save", "--full", "--pixel", "--background", "--changes", "--no-ws", "--stdout",
      "--format", "webp", "--quality", "85", "--scale", "2",
      "--selector", "h1", "--region", "0,0,10,10", "--clip", "0,0,10,10",
      "--element", "3", "--ref", "e7", "--target-max-long-edge", "1568", "--frame", "2",
    ])).toEqual({ ok: true })
  })

  test("global flags the dispatcher strips are still accepted if present", () => {
    expect(validateScreenshotFlags(["--json", "--ws", "--any-tab", "--tab", "99"])).toEqual({ ok: true })
  })

  test("a value that looks like a flag is treated as a value, not a flag", () => {
    // --selector's argument is consumed, so a CSS selector starting with "--"
    // (a custom-property selector) is not mistaken for an unknown flag.
    expect(validateScreenshotFlags(["--selector", "--weird-selector"])).toEqual({ ok: true })
  })

  test("multiple unknown flags are all reported", () => {
    const v = validateScreenshotFlags(["--out", "/tmp/x.png", "--verbose"])
    expect(v.ok).toBe(false)
    if (v.ok) throw new Error("expected rejection")
    expect(v.unknown).toEqual(["--out", "--verbose"])
  })

  test("positional arguments are never treated as flags", () => {
    expect(validateScreenshotFlags(["h1", "some-value"])).toEqual({ ok: true })
  })
})

// ── Acceptance 4 (ask 4): the base64 payload stays off stdout by default ─────

describe("gateDataUrl", () => {
  const dataUrl = `data:image/jpeg;base64,${"A".repeat(4000)}`

  test("withholds the payload by default and reports its size", () => {
    const gate = gateDataUrl(dataUrl, {})
    expect(gate.emit).toBe(false)
    if (gate.emit) throw new Error("expected withheld payload")
    expect(gate.bytes).toBe(3000)
    expect(gate.replacement.dataUrlOmitted).toBe(true)
    expect(String(gate.replacement.hint)).toContain("--save")
    expect(String(gate.replacement.hint)).toContain("--stdout")
  })

  test("--stdout emits it", () => {
    expect(gateDataUrl(dataUrl, { stdout: true })).toEqual({ emit: true })
  })

  test("dataUrlBytes handles a malformed dataUrl without throwing", () => {
    expect(dataUrlBytes("not-a-data-url")).toBe(0)
  })
})

// ── Acceptance 5: lazy images are included or flagged, never silently gone ───

describe("reportLazyImages", () => {
  test("counts lazy images that never decoded", () => {
    const report = reportLazyImages([
      { loading: "lazy", complete: false, naturalWidth: 0, src: "/a.png" },
      { loading: "lazy", complete: true, naturalWidth: 0, src: "/b.png" },
      { loading: "lazy", complete: true, naturalWidth: 800, src: "/c.png" },
      { loading: "eager", complete: false, naturalWidth: 0, src: "/d.png" },
      { loading: null, complete: true, naturalWidth: 400, src: "/e.png" },
    ])
    expect(report.lazyTotal).toBe(3)
    expect(report.lazyNotRendered).toBe(2)
    expect(report.sample).toEqual(["/a.png", "/b.png"])
  })

  test("LOADING is matched case-insensitively", () => {
    const report = reportLazyImages([{ loading: "LAZY", complete: false, naturalWidth: 0, src: "/a.png" }])
    expect(report.lazyNotRendered).toBe(1)
  })

  test("a page whose lazy images all rendered reports nothing", () => {
    const report = reportLazyImages([{ loading: "lazy", complete: true, naturalWidth: 200, src: "/a.png" }])
    expect(report.lazyNotRendered).toBe(0)
    expect(lazyImageWarning(report)).toBeNull()
  })

  test("the warning names the count and the remedy", () => {
    const warning = lazyImageWarning({ lazyNotRendered: 2, sample: ["/a.png"] })
    expect(warning).toContain("2 lazy-loaded images")
    expect(warning).toContain("/a.png")
    expect(warning).toContain("--pixel --full")
  })

  test("extractLazyImageWarning pulls the warning out of a result payload", () => {
    expect(extractLazyImageWarning({ lazyImages: { lazyTotal: 2, lazyNotRendered: 2, sample: [] } }))
      .toContain("2 lazy-loaded images")
    expect(extractLazyImageWarning({ lazyImages: { lazyTotal: 2, lazyNotRendered: 0, sample: [] } })).toBeNull()
    expect(extractLazyImageWarning({ dataUrl: "data:image/png;base64,AAAA" })).toBeNull()
    expect(extractLazyImageWarning(null)).toBeNull()
    expect(extractLazyImageWarning("string payload")).toBeNull()
  })
})
