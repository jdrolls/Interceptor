/**
 * test/screenshot-capture-target.test.ts — wiring test for the capture-target
 * guard (dora-cc#1383 findings 1 + ask 2).
 *
 * `shared/screenshot-contract.ts` proves the decision; this proves the decision
 * is actually consulted on the `--pixel` path and that the result names the
 * page it came from. `chrome.*` is stubbed, so no browser is required.
 */

import { beforeEach, describe, expect, test } from "bun:test"

type StubTab = { id: number; url: string; windowId: number }

let tabs: StubTab[] = []
let activeTabIdByWindow: Record<number, number> = {}
let windowState: string = "normal"
let capturedWindowIds: number[] = []

function installChromeStub() {
  ;(globalThis as any).chrome = {
    tabs: {
      get: async (id: number) => {
        const tab = tabs.find((t) => t.id === id)
        if (!tab) throw new Error(`No tab with id: ${id}`)
        return tab
      },
      query: async ({ active, windowId }: { active?: boolean; windowId?: number }) => {
        if (!active) return tabs
        const activeId = activeTabIdByWindow[windowId as number]
        const tab = tabs.find((t) => t.id === activeId)
        return tab ? [tab] : []
      },
      captureVisibleTab: async (windowId: number) => {
        capturedWindowIds.push(windowId)
        // Deliberately window-scoped, exactly like the real API: it returns the
        // visible tab's pixels no matter which tabId the caller wanted.
        return "data:image/jpeg;base64,QUJDQUJDQUJD"
      },
    },
    windows: {
      get: async (id: number) => ({ id, state: windowState }),
    },
  }
}

beforeEach(() => {
  tabs = [
    { id: 100, url: "https://blog.example/staged-post", windowId: 1 },
    { id: 200, url: "file:///tmp/lifeos-bench-report.html", windowId: 1 },
  ]
  activeTabIdByWindow = { 1: 200 }
  windowState = "normal"
  capturedWindowIds = []
  installChromeStub()
})

async function pixelCapture(action: Record<string, unknown>, tabId: number) {
  const { handleScreenshotActions } = await import("../extension/src/background/capabilities/screenshot")
  return handleScreenshotActions({ type: "screenshot", pixel: true, ...action }, tabId)
}

describe("--pixel capture-target guard", () => {
  test("refuses to capture when the requested tab is not the visible one", async () => {
    const result = await pixelCapture({}, 100)
    expect(result.success).toBe(false)
    expect(result.error).toContain("tab 100")
    expect(result.error).toContain("refusing to silently capture tab 200")
    expect(result.error).toContain("file:///tmp/lifeos-bench-report.html")
    expect(result.error).toContain("INTERCEPTOR_ALLOW_TAB_DRIFT=1")
    // The refusal must happen before any pixels are taken.
    expect(capturedWindowIds).toEqual([])
  })

  test("captures and stamps url + tabId when the requested tab is visible", async () => {
    const result = await pixelCapture({}, 200)
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.tabId).toBe(200)
    expect(data.url).toBe("file:///tmp/lifeos-bench-report.html")
    expect(capturedWindowIds).toEqual([1])
  })

  test("allowTabDrift captures anyway but labels the tab it really photographed", async () => {
    const result = await pixelCapture({ allowTabDrift: true }, 100)
    expect(result.success).toBe(true)
    const data = result.data as Record<string, unknown>
    // Not tab 100 — the payload tells the truth about what was captured.
    expect(data.tabId).toBe(200)
    expect(data.url).toBe("file:///tmp/lifeos-bench-report.html")
    expect(String(data.tabDrift)).toContain("visible tab")
  })

  test("a minimized window is still refused with the pre-existing message", async () => {
    windowState = "minimized"
    const result = await pixelCapture({}, 200)
    expect(result.success).toBe(false)
    expect(result.error).toContain("minimized")
    expect(capturedWindowIds).toEqual([])
  })

  test("a dead tab id is refused by name", async () => {
    const result = await pixelCapture({}, 999)
    expect(result.success).toBe(false)
    expect(result.error).toContain("tab 999 not found")
  })
})
