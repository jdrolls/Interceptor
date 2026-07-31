import { describe, expect, test } from "bun:test"
import { applyTabProvenance, resolveTabFallback } from "../extension/src/background/tab-provenance"

describe("tab provenance", () => {
  test("adds stored provenance to a scalar result envelope", async () => {
    const result = await applyTabProvenance(
      { success: true, data: "scalar", tabId: 42 },
      "stored",
      async () => "https://example.com/stored"
    )

    expect(result).toEqual({
      success: true,
      data: "scalar",
      tabId: 42,
      tabResolvedVia: "stored",
      resolvedTabUrl: "https://example.com/stored"
    })
  })

  test("leaves object result data unmodified while adding stored provenance", async () => {
    const data = { status: "ok" }
    const result = await applyTabProvenance(
      { success: true, data },
      "stored",
      async () => "https://example.com/stored"
    )

    expect(result.data).toBe(data)
    expect(data).toEqual({ status: "ok" })
    expect(result).toMatchObject({
      tabResolvedVia: "stored",
      resolvedTabUrl: "https://example.com/stored"
    })
  })

  test("omits provenance for explicitly targeted tabs", async () => {
    const result = await applyTabProvenance(
      { success: true, data: "explicit" },
      "explicit",
      async () => { throw new Error("should not look up explicit tabs") }
    )

    expect(result).toEqual({ success: true, data: "explicit" })
  })

  test("labels and permits active-cold fallback", async () => {
    const resolution = resolveTabFallback({
      activeTab: { id: 42, url: "https://example.com/cold" }
    })
    expect(resolution).toEqual({
      success: true,
      tabId: 42,
      tabResolvedVia: "active-cold"
    })

    const result = await applyTabProvenance(
      { success: true, tabId: 42 },
      resolution.success ? resolution.tabResolvedVia : undefined,
      async () => "https://example.com/cold"
    )
    expect(result).toMatchObject({ tabResolvedVia: "active-cold" })
  })

  test("refuses active-drift by default with machine-readable provenance", () => {
    const result = resolveTabFallback({
      activeTab: { id: 99, url: "https://example.com/new" },
      staleStoredTabId: 42
    })

    expect(result).toEqual({
      success: false,
      tabId: 99,
      tabResolvedVia: "active-drift",
      error: "stored tab 42 is gone; refusing to silently run on tab 99 (https://example.com/new) — pass --tab explicitly, run 'interceptor open <url>', or set INTERCEPTOR_ALLOW_TAB_DRIFT=1"
    })
  })

  test("allows and labels active-drift only when explicitly opted out", () => {
    expect(resolveTabFallback({
      activeTab: { id: 99, url: "https://example.com/new" },
      staleStoredTabId: 42,
      allowTabDrift: true
    })).toEqual({
      success: true,
      tabId: 99,
      tabResolvedVia: "active-drift"
    })
  })

  test("keeps provenance when the tab URL lookup fails", async () => {
    const result = await applyTabProvenance(
      { success: true, data: "scalar" },
      "stored",
      async () => { throw new Error("tab closed") }
    )

    expect(result).toEqual({ success: true, data: "scalar", tabResolvedVia: "stored" })
  })
})
