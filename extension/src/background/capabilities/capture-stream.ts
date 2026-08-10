import {
  ensureOffscreenForCapture,
  sendToCaptureOffscreen,
  sendToOffscreen,
  unpinOffscreen,
} from "../offscreen"
import { annotateBlankFrame } from "./frame-analysis"

type ActionResult = { success: boolean; error?: string; data?: unknown; tabId?: number }

export async function handleCaptureStreamActions(
  action: { type: string; [key: string]: unknown },
  tabId: number
): Promise<ActionResult> {
  switch (action.type) {
    case "capture_start": {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
      // Rebuild the document with USER_MEDIA and pin it, so neither a
      // pre-existing BLOBS document nor the 30s idle reaper can leave the
      // stream unreachable to the very next `capture frame` (dora-cc#1377).
      await ensureOffscreenForCapture()
      const started = await sendToCaptureOffscreen({ type: "capture_start", streamId })
      if (!started.success) {
        unpinOffscreen()
        return { success: false, error: started.error || "capture start failed" }
      }
      return { success: true, data: { streamId, tabId, ...(started.data as object ?? {}) } }
    }

    case "capture_frame": {
      const fmt = (action.format as string) === "png" ? "image/png" : "image/jpeg"
      const qual = (action.quality as number) || 50
      const frameResult = await sendToCaptureOffscreen({
        type: "capture_frame", format: fmt, quality: qual / 100
      })
      if (!frameResult.success) return { success: false, error: frameResult.error }
      const dataUrl = frameResult.data
      if (typeof dataUrl !== "string") {
        return { success: false, error: "capture frame returned no image data" }
      }
      return annotateBlankFrame({ success: true, data: { dataUrl } })
    }

    case "capture_stop": {
      const stopped = await sendToCaptureOffscreen({ type: "capture_stop" })
      unpinOffscreen()
      try { await chrome.offscreen.closeDocument() } catch {}
      if (!stopped.success) return { success: false, error: stopped.error }
      return { success: true }
    }

    case "canvas_diff": {
      const diffResult = await sendToOffscreen({
        type: "diff",
        image1: action.image1 as string,
        image2: action.image2 as string,
        threshold: (action.threshold as number) || 0,
        returnImage: (action.returnImage as boolean) || false
      })
      if (!diffResult.success) return { success: false, error: diffResult.error }
      return { success: true, data: diffResult.data }
    }
  }
  return { success: false, error: `unknown capture action: ${action.type}` }
}
