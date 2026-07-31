import { sendToContentScript } from "../content-bridge"
import { sendToOffscreen } from "../offscreen"
import { installScreenshotCorsRule, uninstallScreenshotCorsRule } from "./screenshot-cors"
import { deriveStageBudget } from "./screenshot-budget"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

const CAPTURE_TIMEOUT_MS = 5000
const DOM_RENDER_TIMEOUT_MS = 30_000
const DOM_RENDER_ROUNDTRIP_TIMEOUT_MS = 8000
// chrome.scripting.executeScript needs the page renderer's main thread, so it
// can queue behind an abandoned html-to-image pass (observed at 32s/47s/63s).
// Cap runner setup before it can consume the roundtrip and fallback budgets.
const RUNNER_INJECT_TIMEOUT_MS = 3000
// cli/transport.ts sets INTERCEPTOR_TIMEOUT_MS to 15_000ms. The shared 12s
// deadline leaves 3s for daemon relay and dataURL encoding. The CORS-rule and
// runner-injection awaits each cap at 3s; the roundtrip is <= min(8s, remaining
// - 3.5s), and the pixel fallback is <= its remaining budget. The shared
// absolute deadline keeps their serial sum within 12s rather than stacking
// independent caps.
export const SCREENSHOT_TOTAL_BUDGET_MS = 12_000
const SCREENSHOT_STAGE_FLOOR_MS = 100
const PIXEL_FALLBACK_RESERVE_MS = 3_500
// tabCapture is a multi-step media pipeline; a smaller remainder would merely
// create another timeout chain after captureVisibleTab has already failed.
const TAB_CAPTURE_FALLBACK_MIN_BUDGET_MS = CAPTURE_TIMEOUT_MS

type DomRenderResult = {
  success: boolean
  error?: string
  data?: { dataUrl: string; format: string; width: number; height: number; pixelRatio: number; mode: string }
}
const VISIBILITY_HINT = "Chrome/Brave window may not be visible — bring it to the front and retry, or pass --tab <id> of a tab in a visible window."

class CaptureTimeoutError extends Error {
  readonly operation: string
  readonly timeoutMs: number
  readonly budgetExhausted: boolean
  constructor(operation: string, timeoutMs: number, budgetExhausted = false) {
    super(`${operation} timed out after ${timeoutMs}ms`)
    this.name = "CaptureTimeoutError"
    this.operation = operation
    this.timeoutMs = timeoutMs
    this.budgetExhausted = budgetExhausted
  }
}

function getStageTimeout(operation: string, deadline: number | undefined, reserve = 0, stageDefault = CAPTURE_TIMEOUT_MS): number {
  if (deadline === undefined) return CAPTURE_TIMEOUT_MS
  const stage = deriveStageBudget({
    deadline,
    now: Date.now(),
    stageDefault,
    reserve,
    floor: SCREENSHOT_STAGE_FLOOR_MS
  })
  if (stage.budgetExhausted) throw new CaptureTimeoutError(operation, stage.timeoutMs, true)
  return stage.timeoutMs
}

function withDeadlineTimeout<T>(operation: string, p: Promise<T>, deadline?: number, reserve = 0, stageDefault = CAPTURE_TIMEOUT_MS): Promise<T> {
  return withCaptureTimeout(operation, p, getStageTimeout(operation, deadline, reserve, stageDefault))
}

// For stages that carried NO timeout before the deadline budget existed
// (stitch, crop, rect, post-capture transform). Bounding them only matters when
// a deadline is in play; without one, capping them at CAPTURE_TIMEOUT_MS would
// be a NEW ceiling — and stitching a tall full-page capture legitimately runs
// past 5s. Deadline absent => preserve the original unbounded behavior.
function withOptionalDeadlineTimeout<T>(operation: string, p: Promise<T>, deadline?: number, reserve = 0, stageDefault = CAPTURE_TIMEOUT_MS): Promise<T> {
  if (deadline === undefined) return p
  return withDeadlineTimeout(operation, p, deadline, reserve, stageDefault)
}

function captureBudgetFailure(operation: string, timeoutMs: number): ActionResult {
  return {
    success: false,
    error: `${operation} timed out after ${timeoutMs}ms (screenshot budget exhausted)`,
    data: { layer: "captureVisibleTab", timedOutMs: timeoutMs, budgetExhausted: true }
  }
}

function withCaptureTimeout<T>(operation: string, p: Promise<T>, ms = CAPTURE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CaptureTimeoutError(operation, ms)), ms)
    p.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
}

function mimeTypeForFormat(format: string): string {
  if (format === "webp") return "image/webp"
  if (format === "png") return "image/png"
  return "image/jpeg"
}

async function stitchStripsInWorker(
  strips: Array<{ dataUrl: string; y: number }>,
  totalWidth: number,
  totalHeight: number,
  format: string,
  quality: number,
  scale: number = 1
): Promise<string | null> {
  try {
    // Scale during draw, not during allocation. Pre-computing scaled output
    // dimensions avoids hitting the 16384 Skia ceiling on tall pages even if
    // the natural canvas would have exceeded it.
    const outWidth = Math.max(1, Math.round(totalWidth * scale))
    const outHeight = Math.max(1, Math.round(totalHeight * scale))
    const canvas = new OffscreenCanvas(outWidth, outHeight)
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    for (const strip of strips) {
      const res = await fetch(strip.dataUrl)
      const blob = await res.blob()
      const bmp = await createImageBitmap(blob)
      const dx = 0
      const dy = Math.round(strip.y * scale)
      const dw = Math.round(bmp.width * scale)
      const dh = Math.round(bmp.height * scale)
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, dx, dy, dw, dh)
      bmp.close?.()
    }
    const mime = mimeTypeForFormat(format)
    const outBlob = await canvas.convertToBlob({ type: mime, quality })
    const buf = await outBlob.arrayBuffer()
    // base64-encode
    let binary = ""
    const bytes = new Uint8Array(buf)
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    const b64 = btoa(binary)
    return `data:${mime};base64,${b64}`
  } catch (err) {
    console.error("[stitchStripsInWorker] failed:", err)
    return null
  }
}

// ─── DOM render path (default) ────────────────────────────────────────────────

type DomScreenshotMode = "full" | "element" | "selector" | "region"

function resolveDomMode(action: { [key: string]: unknown }): DomScreenshotMode {
  if (typeof action.selector === "string") return "selector"
  if (action.element !== undefined || typeof action.ref === "string") return "element"
  if (action.region || action.clip) return "region"
  return "full"
}

async function injectScreenshotRunner(tabId: number): Promise<{ success: boolean; error?: string }> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED" as chrome.scripting.ExecutionWorld,
      files: ["screenshot-runner.js"]
    })
    return { success: true }
  } catch (err) {
    return { success: false, error: `failed to inject screenshot-runner.js: ${(err as Error).message}` }
  }
}

// Re-encode a PNG/JPEG dataUrl as WebP using OffscreenCanvas.
// html-to-image only emits PNG/JPEG, and chrome.tabs.captureVisibleTab only
// accepts PNG/JPEG. WebP support is added by re-encoding at the SW boundary.
async function reencodeAsWebP(dataUrl: string, qualityPct: number): Promise<string> {
  const res = await fetch(dataUrl)
  const blob = await res.blob()
  const bmp = await createImageBitmap(blob)
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable")
    ctx.drawImage(bmp, 0, 0)
    const out = await canvas.convertToBlob({ type: "image/webp", quality: Math.max(0, Math.min(1, qualityPct / 100)) })
    const buf = await out.arrayBuffer()
    let binary = ""
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return `data:image/webp;base64,${btoa(binary)}`
  } finally {
    bmp.close?.()
  }
}

async function fallbackToPixelAfterTimeout(
  action: { type: string; [key: string]: unknown },
  tabId: number,
  deadline: number,
  timeout: CaptureTimeoutError,
  fallbackLabel: string,
  errorOperation: string,
  layer: string,
  returnCaptureFailure = false
): Promise<ActionResult> {
  const fallback = await handlePixelScreenshot({ ...action, pixel: true }, tabId, deadline)
  if (fallback.success && fallback.data && typeof fallback.data === "object") {
    (fallback.data as Record<string, unknown>).fallback = fallbackLabel
    return fallback
  }
  if (returnCaptureFailure && (fallback.data as { layer?: string } | undefined)?.layer === "captureVisibleTab") {
    return fallback
  }
  return {
    success: false,
    error: `${errorOperation} timed out after ${timeout.timeoutMs}ms and captureVisibleTab fallback failed: ${fallback.error || "unknown error"}`,
    data: { layer, timedOutMs: timeout.timeoutMs, budgetExhausted: true }
  }
}

async function handleDomRenderScreenshot(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  const deadline = Date.now() + SCREENSHOT_TOTAL_BUDGET_MS
  const mode = resolveDomMode(action)
  const requestedFormat = (action.format as string) === "webp" ? "webp"
    : (action.format as string) === "jpeg" ? "jpeg"
    : "png"
  // For WebP requests, render PNG (lossless) in the content script and re-encode
  // at the SW boundary. JPEG → WebP would double-lossy.
  const renderFormat = requestedFormat === "webp" ? "png" : requestedFormat
  const quality = typeof action.quality === "number" ? (action.quality as number) : 92
  // WebP default quality is 85; other formats keep their existing default of 92.
  const webpQuality = typeof action.quality === "number" ? (action.quality as number) : 85
  const scale = typeof action.scale === "number" ? (action.scale as number) : undefined
  const targetMaxLongEdge = typeof action.target_max_long_edge === "number"
    ? (action.target_max_long_edge as number)
    : undefined

  const region = (action.region || action.clip) as { x: number; y: number; width: number; height: number } | undefined

  const targetTab = await chrome.tabs.get(tabId).catch(() => null)
  if (!targetTab) {
    return { success: false, error: `tab ${tabId} not found` }
  }

  try {
    await withDeadlineTimeout(
      "installScreenshotCorsRule",
      installScreenshotCorsRule(tabId),
      deadline,
      PIXEL_FALLBACK_RESERVE_MS,
      RUNNER_INJECT_TIMEOUT_MS
    )

    let inject: { success: boolean; error?: string }
    try {
      inject = await withDeadlineTimeout(
        "screenshot-runner injection",
        injectScreenshotRunner(tabId),
        deadline,
        PIXEL_FALLBACK_RESERVE_MS,
        RUNNER_INJECT_TIMEOUT_MS
      )
    } catch (err) {
      if (err instanceof CaptureTimeoutError) {
        return fallbackToPixelAfterTimeout(
          action,
          tabId,
          deadline,
          err,
          "pixel (screenshot-runner injection timed out)",
          "screenshot-runner injection",
          "executeScript"
        )
      }
      throw err
    }
    if (!inject.success) return { success: false, error: inject.error || "runner injection failed", data: { layer: "executeScript" } }

    const dsAction: { type: string; [key: string]: unknown } = { type: "dom_screenshot", mode, format: renderFormat, quality }
    if (action.ref !== undefined) dsAction.ref = action.ref
    if (action.element !== undefined) dsAction.index = action.element
    if (action.selector !== undefined) dsAction.selector = action.selector
    if (region) dsAction.region = region
    if (scale !== undefined) dsAction.scale = scale
    if (targetMaxLongEdge !== undefined) dsAction.target_max_long_edge = targetMaxLongEdge

    let renderResult: DomRenderResult
    try {
      const roundtrip = deriveStageBudget({
        deadline,
        now: Date.now(),
        stageDefault: DOM_RENDER_ROUNDTRIP_TIMEOUT_MS,
        reserve: PIXEL_FALLBACK_RESERVE_MS,
        floor: SCREENSHOT_STAGE_FLOOR_MS
      })
      if (roundtrip.budgetExhausted) {
        return {
          success: false,
          error: `domRenderRoundtrip timed out after ${roundtrip.timeoutMs}ms (screenshot budget exhausted)`,
          data: { layer: "domRenderRoundtrip", timedOutMs: roundtrip.timeoutMs, budgetExhausted: true }
        }
      }
      renderResult = await withCaptureTimeout(
        "domRenderRoundtrip",
        sendToContentScript(tabId, dsAction) as Promise<DomRenderResult>,
        roundtrip.timeoutMs
      )
    } catch (err) {
      if (err instanceof CaptureTimeoutError) {
        return fallbackToPixelAfterTimeout(
          action,
          tabId,
          deadline,
          err,
          "pixel (dom-render roundtrip timed out)",
          "domRenderRoundtrip",
          "domRenderRoundtrip",
          true
        )
      }
      throw err
    }

    if (!renderResult || !renderResult.success || !renderResult.data) {
      return {
        success: false,
        error: renderResult?.error || "dom render returned no data (content-script roundtrip produced no result)",
        data: { layer: "domRenderRoundtrip" }
      }
    }

    let dataUrl = renderResult.data.dataUrl
    const width = renderResult.data.width
    const height = renderResult.data.height
    let outputFormat = renderResult.data.format

    if (requestedFormat === "webp") {
      try {
        dataUrl = await withDeadlineTimeout("domRenderRoundtrip re-encode", reencodeAsWebP(dataUrl, webpQuality), deadline)
        outputFormat = "webp"
      } catch (err) {
        return { success: false, error: `webp re-encode failed: ${(err as Error).message}` }
      }
    }

    const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)

    if (action.save) {
      return { success: true, data: { dataUrl, format: outputFormat, size: sizeBytes, width, height, mode, save: true } }
    }

    return { success: true, data: { dataUrl, format: outputFormat, size: sizeBytes, width, height, mode } }
  } finally {
    await uninstallScreenshotCorsRule(tabId)
  }
}

// ─── Pixel-true path (--pixel escape hatch) ───────────────────────────────────

export async function handleScreenshotBackground(
  action: { type: string; [key: string]: unknown },
  tabId: number,
  deadline?: number
): Promise<ActionResult> {
  const format = (action.format as string) === "png" ? "image/png" : "image/jpeg"
  const quality = ((action.quality as number) || 50) / 100
  try {
    const streamId = await withDeadlineTimeout(
      "tabCapture.getMediaStreamId",
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }),
      deadline
    )
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType]
    })
    if (contexts.length === 0) {
      await withDeadlineTimeout(
        "offscreen.createDocument",
        chrome.offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
          justification: "Background tab screenshot via tabCapture"
        }),
        deadline
      )
    }
    await withDeadlineTimeout(
      "offscreen.capture_start",
      new Promise<void>((resolve) => {
        chrome.runtime.sendMessage({ target: "offscreen", type: "capture_start", streamId }, () => resolve())
      }),
      deadline
    )
    await new Promise(r => setTimeout(r, 300))
    const frameResult = await withDeadlineTimeout(
      "offscreen.capture_frame",
      sendToOffscreen({ type: "capture_frame", format, quality }),
      deadline
    ) as { success: boolean; data?: string; error?: string }
    await withDeadlineTimeout(
      "offscreen.capture_stop",
      sendToOffscreen({ type: "capture_stop" }),
      deadline
    ).catch(() => undefined)
    if (!frameResult.success) return { success: false, error: frameResult.error || "capture frame failed" }
    const dataUrl = frameResult.data!
    const sizeBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75)
    return { success: true, data: { dataUrl, format: action.format || "jpeg", size: sizeBytes, method: "tabCapture" } }
  } catch (err) {
    if (err instanceof CaptureTimeoutError) {
      return {
        success: false,
        error: `tabCapture timed out at ${err.operation} (${err.timeoutMs}ms)`,
        data: { hint: VISIBILITY_HINT, layer: "tabCapture", timedOutAt: err.operation, timedOutMs: err.timeoutMs, budgetExhausted: err.budgetExhausted }
      }
    }
    return { success: false, error: `tabCapture failed: ${(err as Error).message}` }
  }
}

async function handlePixelScreenshot(
  action: { type: string; [key: string]: unknown },
  tabId: number,
  deadline?: number
): Promise<ActionResult> {
  // Output format requested by caller. WebP is supported via OffscreenCanvas
  // re-encode (chrome.tabs.captureVisibleTab itself only emits PNG/JPEG).
  const requestedFormat = (action.format as string) === "webp" ? "webp"
    : (action.format as string) === "png" ? "png"
    : "jpeg"
  // captureVisibleTab format: WebP requests use PNG strips (lossless source) so
  // the OffscreenCanvas re-encode can produce a clean WebP output.
  const captureFormat = requestedFormat === "webp" ? "png" : requestedFormat
  const quality = (action.quality as number) || 50
  const targetMaxLongEdge = typeof action.target_max_long_edge === "number"
    ? (action.target_max_long_edge as number)
    : undefined

  if (action.full) {
    const dims = await sendToContentScript(tabId, { type: "get_page_dimensions" }) as {
      success: boolean
      data?: { scrollHeight: number; scrollWidth: number; viewportHeight: number; viewportWidth: number; scrollY: number; devicePixelRatio: number }
    }
    if (!dims.success || !dims.data) return { success: false, error: "failed to get page dimensions" }
    const { scrollHeight, viewportHeight, viewportWidth, scrollY: origScrollY, devicePixelRatio } = dims.data
    const stripCount = Math.ceil(scrollHeight / viewportHeight)
    const strips: { dataUrl: string; y: number }[] = []

    const fullTab = await chrome.tabs.get(tabId).catch(() => null)
    if (!fullTab) return { success: false, error: `tab ${tabId} not found`, data: { hint: VISIBILITY_HINT } }
    const fullWindow = await chrome.windows.get(fullTab.windowId, { populate: false }).catch(() => null)
    if (fullWindow && fullWindow.state === "minimized") {
      return {
        success: false,
        error: `window ${fullTab.windowId} is minimized — captureVisibleTab cannot capture minimized windows`,
        data: { hint: VISIBILITY_HINT, layer: "preflight", windowState: fullWindow.state }
      }
    }

    for (let i = 0; i < stripCount; i++) {
      const stripsRemaining = stripCount - i
      const stageReserve = stripsRemaining > 1 ? (stripsRemaining - 1) * SCREENSHOT_STAGE_FLOOR_MS : 0
      const sharedStageDefault = deadline === undefined
        ? CAPTURE_TIMEOUT_MS
        : Math.max(SCREENSHOT_STAGE_FLOOR_MS, Math.floor((deadline - Date.now()) / stripsRemaining))
      const scrollTo = i * viewportHeight
      await sendToContentScript(tabId, { type: "scroll_absolute", y: scrollTo })
      await new Promise(r => setTimeout(r, 150))
      let stripUrl: string
      try {
        stripUrl = await withDeadlineTimeout(
          `captureVisibleTab(strip ${i + 1}/${stripCount})`,
          chrome.tabs.captureVisibleTab(fullTab.windowId, { format: captureFormat, quality }),
          deadline,
          stageReserve,
          sharedStageDefault
        )
      } catch (err) {
        await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY }).catch(() => undefined)
        if (err instanceof CaptureTimeoutError) {
          const failure = captureBudgetFailure(err.operation, err.timeoutMs)
          ;(failure.data as Record<string, unknown>).hint = VISIBILITY_HINT
          ;(failure.data as Record<string, unknown>).strip = i + 1
          ;(failure.data as Record<string, unknown>).totalStrips = stripCount
          return failure
        }
        return { success: false, error: `captureVisibleTab failed on strip ${i + 1}/${stripCount}: ${(err as Error).message}` }
      }
      strips.push({ dataUrl: stripUrl, y: Math.round(scrollTo * devicePixelRatio) })
      // Chrome rate-limits captureVisibleTab to MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
      // (default: 2/sec). 1100ms between strips clears the quota with margin.
      if (i < stripCount - 1) await new Promise(r => setTimeout(r, 1100))
    }

    await sendToContentScript(tabId, { type: "scroll_absolute", y: origScrollY }).catch(() => undefined)

    // Stitch inline in the SW using OffscreenCanvas — avoids the
    // SW ↔ offscreen-document IPC round-trip which silently drops
    // multi-hundred-KB messages. The SW already has access to
    // OffscreenCanvas + createImageBitmap (it's a Worker context).
    //
    // When target_max_long_edge is set, compute a downsample scale and pass it
    // to the stitch so the output OffscreenCanvas allocation never approaches
    // the 16384 Skia ceiling.
    const naturalWidth = Math.round(viewportWidth * devicePixelRatio)
    const naturalHeight = Math.round(scrollHeight * devicePixelRatio)
    let stitchScale = 1
    if (targetMaxLongEdge !== undefined && targetMaxLongEdge > 0) {
      const longEdge = Math.max(naturalWidth, naturalHeight)
      if (longEdge > targetMaxLongEdge) stitchScale = targetMaxLongEdge / longEdge
    }
    // WebP output uses default quality 85; PNG/JPEG keep their existing
    // quality semantics.
    const stitchQuality = requestedFormat === "webp"
      ? (typeof action.quality === "number" ? (action.quality as number) : 85) / 100
      : quality / 100
    let stitchedUrl: string | null
    try {
      stitchedUrl = await withOptionalDeadlineTimeout(
        "captureVisibleTab stitch",
        stitchStripsInWorker(strips, naturalWidth, naturalHeight, requestedFormat, stitchQuality, stitchScale),
        deadline
      )
    } catch (err) {
      if (err instanceof CaptureTimeoutError) return captureBudgetFailure(err.operation, err.timeoutMs)
      return { success: false, error: `stitch failed: ${(err as Error).message}` }
    }
    if (!stitchedUrl) return { success: false, error: "stitch failed (could not render strips into OffscreenCanvas)" }
    const stitchedSize = Math.round((stitchedUrl.length - stitchedUrl.indexOf(",") - 1) * 0.75)
    if (action.save) {
      return { success: true, data: { dataUrl: stitchedUrl, format: requestedFormat, size: stitchedSize, save: true, strips: stripCount } }
    }
    return { success: true, data: { dataUrl: stitchedUrl, format: requestedFormat, size: stitchedSize, strips: stripCount } }
  }

  const targetTab = await chrome.tabs.get(tabId).catch(() => null)
  if (!targetTab) {
    return { success: false, error: `tab ${tabId} not found`, data: { hint: VISIBILITY_HINT } }
  }
  const targetWindow = await chrome.windows.get(targetTab.windowId, { populate: false }).catch(() => null)
  if (targetWindow && targetWindow.state === "minimized") {
    return {
      success: false,
      error: `window ${targetTab.windowId} is minimized — captureVisibleTab cannot capture minimized windows`,
      data: { hint: VISIBILITY_HINT, layer: "preflight", windowState: targetWindow.state }
    }
  }

  let dataUrl: string
  try {
    dataUrl = await withDeadlineTimeout(
      "captureVisibleTab",
      chrome.tabs.captureVisibleTab(targetTab.windowId, { format: captureFormat, quality }),
      deadline
    )
  } catch (err) {
    if (err instanceof CaptureTimeoutError) {
      const failure = captureBudgetFailure(err.operation, err.timeoutMs)
      ;(failure.data as Record<string, unknown>).hint = VISIBILITY_HINT
      return failure
    }
    if (deadline !== undefined && deadline - Date.now() < TAB_CAPTURE_FALLBACK_MIN_BUDGET_MS) {
      return captureBudgetFailure("captureVisibleTab fallback", Math.max(0, deadline - Date.now()))
    }
    const fallback = await handleScreenshotBackground(
      { type: "screenshot_background", format: action.format, quality: action.quality },
      tabId,
      deadline
    )
    if (fallback.success && fallback.data) {
      (fallback.data as Record<string, unknown>).fallback = "tabCapture (captureVisibleTab failed)"
    }
    return fallback
  }

  let clip = action.clip as { x: number; y: number; width: number; height: number } | undefined
  if (!clip && action.element !== undefined) {
    const elemResult = await withOptionalDeadlineTimeout(
      "captureVisibleTab rect",
      sendToContentScript(tabId, { type: "rect", index: action.element }),
      deadline
    ) as { success: boolean; data?: { x: number; y: number; width: number; height: number } }
    if (elemResult.success && elemResult.data) clip = elemResult.data
  }

  if (clip) {
    const cropResult = await withOptionalDeadlineTimeout("captureVisibleTab crop", sendToOffscreen({ type: "crop", dataUrl, clip }), deadline) as {
      success: boolean; data?: string; error?: string
    }
    if (!cropResult.success) return { success: false, error: cropResult.error }
    dataUrl = cropResult.data!
  }

  // Post-capture transform — downsample to fit target_max_long_edge and/or
  // re-encode to WebP. Done in one OffscreenCanvas pass for efficiency.
  let transformed: Awaited<ReturnType<typeof transformPixelDataUrl>>
  try {
    transformed = await withOptionalDeadlineTimeout(
      "captureVisibleTab transform",
      transformPixelDataUrl(dataUrl, requestedFormat, action.quality as number | undefined, targetMaxLongEdge),
      deadline
    )
  } catch (err) {
    if (err instanceof CaptureTimeoutError) return captureBudgetFailure(err.operation, err.timeoutMs)
    return { success: false, error: `post-capture transform failed: ${(err as Error).message}` }
  }
  if (!transformed.success) return { success: false, error: transformed.error || "post-capture transform failed" }
  const finalUrl = transformed.dataUrl
  const finalSize = Math.round((finalUrl.length - finalUrl.indexOf(",") - 1) * 0.75)

  if (action.save) {
    return { success: true, data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize, save: true } }
  }

  if (clip) {
    return { success: true, data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize, clip } }
  }

  if (requestedFormat === "png" && finalSize > 800 * 1024) {
    return {
      success: true,
      data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize, warning: "PNG exceeds 800KB — consider using JPEG or WebP for smaller responses" }
    }
  }
  return { success: true, data: { dataUrl: finalUrl, format: requestedFormat, size: finalSize } }
}

// Post-capture transform for the pixel path. Applies downsample
// (target_max_long_edge) and/or format re-encode (PNG/JPEG/WebP) in one
// OffscreenCanvas pass. Returns the same dataUrl unchanged when no transform
// is needed, so callers pay zero cost for default invocations.
async function transformPixelDataUrl(
  dataUrl: string,
  requestedFormat: string,
  quality: number | undefined,
  targetMaxLongEdge: number | undefined
): Promise<{ success: true; dataUrl: string } | { success: false; error: string }> {
  // Detect current MIME from the dataUrl prefix so we can short-circuit no-ops.
  const currentMime = dataUrl.startsWith("data:image/webp") ? "webp"
    : dataUrl.startsWith("data:image/png") ? "png"
    : "jpeg"
  const formatChange = currentMime !== requestedFormat
  const needsDownsample = targetMaxLongEdge !== undefined && targetMaxLongEdge > 0
  if (!formatChange && !needsDownsample) {
    return { success: true, dataUrl }
  }
  try {
    const res = await fetch(dataUrl)
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob)
    try {
      let scale = 1
      if (needsDownsample) {
        const longEdge = Math.max(bmp.width, bmp.height)
        if (longEdge > targetMaxLongEdge!) scale = targetMaxLongEdge! / longEdge
      }
      const outWidth = Math.max(1, Math.round(bmp.width * scale))
      const outHeight = Math.max(1, Math.round(bmp.height * scale))
      const canvas = new OffscreenCanvas(outWidth, outHeight)
      const ctx = canvas.getContext("2d")
      if (!ctx) return { success: false, error: "OffscreenCanvas 2d context unavailable" }
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, outWidth, outHeight)
      const mime = mimeTypeForFormat(requestedFormat)
      const encodeQuality = requestedFormat === "webp"
        ? Math.max(0, Math.min(1, (typeof quality === "number" ? quality : 85) / 100))
        : Math.max(0, Math.min(1, (typeof quality === "number" ? quality : 50) / 100))
      const outBlob = await canvas.convertToBlob({ type: mime, quality: encodeQuality })
      const buf = await outBlob.arrayBuffer()
      let binary = ""
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      return { success: true, dataUrl: `data:${mime};base64,${btoa(binary)}` }
    } finally {
      bmp.close?.()
    }
  } catch (err) {
    return { success: false, error: `transform failed: ${(err as Error).message}` }
  }
}

// ─── Public dispatcher ────────────────────────────────────────────────────────

export async function handleScreenshotActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "screenshot_background":
      return handleScreenshotBackground(action, tabId)

    case "page_capture": {
      const mhtml = await chrome.pageCapture.saveAsMHTML({ tabId })
      const text = await (mhtml as Blob).text()
      return { success: true, data: { size: text.length, preview: text.slice(0, 500) } }
    }

    case "screenshot": {
      // --pixel flag routes to the legacy captureVisibleTab path. Default
      // path is the DOM-render pipeline.
      if (action.pixel === true) {
        return handlePixelScreenshot(action, tabId)
      }
      return handleDomRenderScreenshot(action, tabId)
    }
  }
  return { success: false, error: `unknown screenshot action: ${action.type}` }
}
