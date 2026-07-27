import { describe, expect, test } from "bun:test"
import { applyTabProvenance } from "../extension/src/background/tab-provenance"

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

  test("adds active-drift provenance to the envelope", async () => {
    const result = await applyTabProvenance(
      { success: true, data: null },
      "active-drift",
      async () => "https://example.com/active"
    )

    expect(result).toMatchObject({
      tabResolvedVia: "active-drift",
      resolvedTabUrl: "https://example.com/active"
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
