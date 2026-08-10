/**
 * shared/screenshot-contract.ts — the honesty contract for `interceptor screenshot`.
 *
 * Interceptor is the sanctioned web-verification surface, so a capture that
 * looks fine but is not what was asked for is worse than a crash. Four exit-0
 * false-evidence modes were reported in dora-cc#1383:
 *
 *   1. `--pixel` returns the *focused* tab's pixels when the target tab is not
 *      the visible one — `chrome.tabs.captureVisibleTab` is window-scoped, not
 *      tab-scoped, so the tabId the caller asked for is never consulted.
 *   2. An unknown flag (`--out`) parsed as nothing and fell through to printing
 *      the whole base64 image on stdout.
 *   3. `error:` lines were printed at exit 0.
 *   4. A DOM capture silently dropped `loading="lazy"` images that had never
 *      entered the viewport.
 *
 * Everything here is a pure function over plain data so the contract can be
 * tested without a browser, a Mac, or a live daemon — same doctrine as
 * shared/frame-analysis.ts.
 */

// ─── 1. Capture-target assertion (ask 1) ──────────────────────────────────────

export type CaptureTargetCheck =
  | { ok: true; drifted: false }
  | { ok: true; drifted: true; capturedTabId: number; capturedTabUrl?: string }
  | { ok: false; error: string; capturedTabId?: number; capturedTabUrl?: string }

/**
 * `chrome.tabs.captureVisibleTab(windowId)` photographs whichever tab is active
 * in that window. When the requested tab is not that tab, the returned image is
 * a *different page* — the exact wrong-page evidence #1383 was filed for.
 *
 * Refuse by default, in the same message shape `eval`'s tab-drift guard uses
 * (name both tabs, name the URL, name the escape hatches).
 */
export function assertCaptureTarget(opts: {
  requestedTabId: number
  requestedTabUrl?: string
  visibleTabId?: number
  visibleTabUrl?: string
  windowId?: number
  allowTabDrift?: boolean
}): CaptureTargetCheck {
  const { requestedTabId, visibleTabId } = opts
  if (visibleTabId === undefined) {
    return {
      ok: false,
      error:
        `refusing to capture: window ${opts.windowId ?? "unknown"} reports no visible tab, so ` +
        `captureVisibleTab cannot be attributed to tab ${requestedTabId} — ` +
        "raise the window and retry, or pass --tab explicitly",
    }
  }
  if (visibleTabId === requestedTabId) return { ok: true, drifted: false }

  if (opts.allowTabDrift) {
    return { ok: true, drifted: true, capturedTabId: visibleTabId, capturedTabUrl: opts.visibleTabUrl }
  }

  return {
    ok: false,
    capturedTabId: visibleTabId,
    capturedTabUrl: opts.visibleTabUrl,
    error:
      `target tab ${requestedTabId} (${opts.requestedTabUrl || "unknown URL"}) is not the visible tab; ` +
      `refusing to silently capture tab ${visibleTabId} (${opts.visibleTabUrl || "unknown URL"}) instead — ` +
      "pass --tab explicitly, run 'interceptor open <url>', activate the target tab, " +
      "or set INTERCEPTOR_ALLOW_TAB_DRIFT=1",
  }
}

// ─── 2. Unknown-flag rejection (ask 3) ────────────────────────────────────────

/** Flags that consume the following argv token as their value. */
export const SCREENSHOT_VALUE_FLAGS = new Set([
  "--format",
  "--quality",
  "--scale",
  "--selector",
  "--region",
  "--clip",
  "--element",
  "--ref",
  "--target-max-long-edge",
  "--frame",
])

/** Flags that stand alone. */
export const SCREENSHOT_BOOLEAN_FLAGS = new Set([
  "--save",
  "--stdout",
  "--full",
  "--pixel",
  "--background",
  "--changes",
  "--no-ws",
  "--help",
  "-h",
])

/**
 * Global flags stripped by cli/index.ts before the command parser sees argv.
 * Listed so the validator stays correct if that filtering ever moves.
 */
export const SCREENSHOT_GLOBAL_FLAGS = new Set(["--json", "--ws", "--any-tab", "--tab"])

export type FlagValidation = { ok: true } | { ok: false; unknown: string[]; error: string }

/**
 * Reject any `--flag` the screenshot command does not implement.
 *
 * The old parser looked only for flags it knew and ignored the rest, so
 * `--out /tmp/x.png` (there is no `--out`; the real flag is `--save`) parsed to
 * a plain screenshot that then dumped its base64 payload to stdout at exit 0.
 * An unrecognised flag means the caller's intent was not honoured, which for a
 * verification tool is a hard error.
 */
export function validateScreenshotFlags(args: string[]): FlagValidation {
  const unknown: string[] = []
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (!token.startsWith("--") && token !== "-h") continue
    if (SCREENSHOT_VALUE_FLAGS.has(token)) {
      i++ // consume the value so a value that looks like a flag is not re-checked
      continue
    }
    if (SCREENSHOT_BOOLEAN_FLAGS.has(token) || SCREENSHOT_GLOBAL_FLAGS.has(token)) continue
    unknown.push(token)
  }
  if (unknown.length === 0) return { ok: true }

  const known = [...SCREENSHOT_BOOLEAN_FLAGS, ...SCREENSHOT_VALUE_FLAGS]
    .filter((f) => f !== "-h" && f !== "--help")
    .sort()
    .join(" ")
  const outHint = unknown.includes("--out")
    ? "\n  --out is not a flag; use --save to write the capture to a file."
    : ""
  return {
    ok: false,
    unknown,
    error:
      `unknown flag${unknown.length > 1 ? "s" : ""} for 'interceptor screenshot': ${unknown.join(", ")}` +
      outHint +
      `\n  known flags: ${known}`,
  }
}

// ─── 3. stdout payload gating (ask 4) ─────────────────────────────────────────

export type DataUrlGate =
  | { emit: true }
  | { emit: false; bytes: number; replacement: Record<string, unknown> }

/** Bytes of decoded image represented by a base64 dataUrl. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",")
  if (comma === -1) return 0
  return Math.round((dataUrl.length - comma - 1) * 0.75)
}

/**
 * Decide whether a capture's base64 payload may be written to stdout.
 *
 * A full-page capture is megabytes of base64. Printing it by default floods a
 * terminal and (worse) an agent's context window — ~20k tokens in one call in
 * the #1383 report — while carrying no information a human or agent can read.
 * Emit it only when the caller asked with `--stdout`.
 */
export function gateDataUrl(dataUrl: string, opts: { stdout?: boolean }): DataUrlGate {
  if (opts.stdout) return { emit: true }
  const bytes = dataUrlBytes(dataUrl)
  return {
    emit: false,
    bytes,
    replacement: {
      dataUrlOmitted: true,
      dataUrlBytes: bytes,
      hint: "base64 payload withheld from stdout — re-run with --save to write a file, or --stdout to print it",
    },
  }
}

// ─── 4. Lazy-image accounting (ask 6) ─────────────────────────────────────────

export type LazyImageProbe = {
  loading?: string | null
  complete?: boolean
  naturalWidth?: number
  src?: string | null
}

export type LazyImageReport = {
  lazyTotal: number
  lazyNotRendered: number
  sample: string[]
}

/**
 * Count `loading="lazy"` images that never decoded.
 *
 * html-to-image rasterises the DOM as it stands. An image below the fold has
 * not been fetched, so it renders as nothing at all — no box, no placeholder —
 * which reads identically to "this page's images are broken". Counting them is
 * what turns a false negative into a stated limitation.
 */
export function reportLazyImages(imgs: LazyImageProbe[], sampleLimit = 3): LazyImageReport {
  const lazy = imgs.filter((img) => (img.loading || "").toLowerCase() === "lazy")
  const unrendered = lazy.filter((img) => img.complete !== true || (img.naturalWidth ?? 0) === 0)
  return {
    lazyTotal: lazy.length,
    lazyNotRendered: unrendered.length,
    sample: unrendered
      .slice(0, sampleLimit)
      .map((img) => img.src || "(no src)"),
  }
}

/** One-line operator-facing warning, or null when nothing was dropped. */
export function lazyImageWarning(report: Pick<LazyImageReport, "lazyNotRendered" | "sample">): string | null {
  if (report.lazyNotRendered <= 0) return null
  const sample = report.sample.length > 0 ? ` (e.g. ${report.sample.join(", ")})` : ""
  return (
    `${report.lazyNotRendered} lazy-loaded image${report.lazyNotRendered === 1 ? "" : "s"} ` +
    `never entered the viewport and ${report.lazyNotRendered === 1 ? "is" : "are"} absent from this capture${sample} — ` +
    "scroll the page first, or use --pixel --full which scrolls as it captures"
  )
}

/** Pull the lazy-image warning out of a result payload, for the CLI's stderr. */
export function extractLazyImageWarning(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const report = (data as { lazyImages?: unknown }).lazyImages
  if (!report || typeof report !== "object") return null
  const { lazyNotRendered, sample } = report as { lazyNotRendered?: unknown; sample?: unknown }
  if (typeof lazyNotRendered !== "number" || lazyNotRendered <= 0) return null
  return lazyImageWarning({
    lazyNotRendered,
    sample: Array.isArray(sample) ? sample.filter((s): s is string => typeof s === "string") : [],
  })
}
