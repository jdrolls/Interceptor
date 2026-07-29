import { describe, expect, test } from "bun:test"
import { detectRecentTimeouts } from "../cli/commands/doctor"
import { countManagedTabs, detectSplitBrain } from "../cli/lib/daemon-health"
import { deriveStageBudget } from "../extension/src/background/capabilities/screenshot-budget"

describe("doctor: detectRecentTimeouts", () => {
  const NOW = 1_000_000_000_000 // fixed reference time
  const iso = (ms: number) => new Date(ms).toISOString()

  test("empty events → not degraded, count 0", () => {
    expect(detectRecentTimeouts([], NOW)).toEqual({ degraded: false, count: 0 })
  })

  test("counts only timeout-error events inside the 60s window", () => {
    const events = [
      { timestamp: iso(NOW - 1_000), error: "timeout: no response for 'evaluate' after 15s" },
      { timestamp: iso(NOW - 2_000), error: "timeout: no response for 'screenshot' after 15s" },
      { timestamp: iso(NOW - 90_000), error: "timeout: too old, outside window" }, // excluded (old)
      { timestamp: iso(NOW - 3_000), error: "navigation failed" },                  // excluded (not timeout)
      { timestamp: iso(NOW - 4_000), event: "complete" },                            // excluded (no error)
    ]
    expect(detectRecentTimeouts(events, NOW)).toEqual({ degraded: false, count: 2 })
  })

  test("counts explicit request_timeout events without error fields and mixes legacy entries", () => {
    const events = [
      { timestamp: iso(NOW - 1_000), event: "request_timeout" },
      { timestamp: iso(NOW - 2_000), error: "timeout: legacy entry" },
      { timestamp: iso(NOW - 90_000), event: "request_timeout" },
    ]
    expect(detectRecentTimeouts(events, NOW)).toEqual({ degraded: false, count: 2 })
  })

  test("timeout matching is case-insensitive", () => {
    const events = [{ timestamp: iso(NOW - 500), error: "TIMEOUT firing" }]
    expect(detectRecentTimeouts(events, NOW).count).toBe(1)
  })

  test("events without a timestamp are counted (best-effort)", () => {
    const events = [
      { error: "timeout a" },
      { error: "timeout b" },
      { error: "timeout c" },
    ]
    expect(detectRecentTimeouts(events, NOW)).toEqual({ degraded: true, count: 3 })
  })

  test("degraded true exactly at the default threshold (3), false at 2", () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ timestamp: iso(NOW - i * 1_000), error: "timeout" }))
    expect(detectRecentTimeouts(mk(2), NOW).degraded).toBe(false)
    expect(detectRecentTimeouts(mk(3), NOW).degraded).toBe(true)
  })
})

describe("doctor: detectSplitBrain", () => {
  test("detects a disconnected extension served by a different WS daemon and reports orphans", () => {
    const result = detectSplitBrain({
      daemonPid: 101,
      wsOwnerPid: 202,
      extensionOk: false,
      daemonPids: [101, 202, 303]
    })

    expect(result.split).toBe(true)
    expect(result.detail).toContain("daemon pid 202")
    expect(result.detail).toContain("pid 101")
    expect(result.detail).toContain("2 orphaned daemon(s)")
  })

  test("does not report split-brain when the extension is healthy", () => {
    expect(detectSplitBrain({
      daemonPid: 101,
      wsOwnerPid: 202,
      extensionOk: true,
      daemonPids: [101, 202]
    }).split).toBe(false)
  })

  test("does not report split-brain when the WS owner is the CLI daemon", () => {
    expect(detectSplitBrain({
      daemonPid: 101,
      wsOwnerPid: 101,
      extensionOk: false,
      daemonPids: [101]
    }).split).toBe(false)
  })

  test("does not report split-brain without a WS owner", () => {
    expect(detectSplitBrain({
      daemonPid: 101,
      wsOwnerPid: null,
      extensionOk: false,
      daemonPids: [101]
    }).split).toBe(false)
  })
})

describe("doctor: countManagedTabs", () => {
  test("empty tabs → 0", () => {
    expect(countManagedTabs([])).toBe(0)
  })

  test("counts only tabs explicitly marked managed", () => {
    expect(countManagedTabs([
      { managed: true },
      { managed: false },
      {},
      { managed: true },
    ])).toBe(2)
  })

  test("4 managed plus 8 unmanaged tabs observed live does not trip the limit of 8", () => {
    const tabs = [
      ...Array.from({ length: 4 }, () => ({ managed: true })),
      ...Array.from({ length: 8 }, () => ({ managed: false })),
    ]
    expect(countManagedTabs(tabs)).toBe(4)
    expect(countManagedTabs(tabs)).toBeLessThanOrEqual(8)
  })
})

describe("screenshot deadline budget", () => {
  test("stage allocations cannot spend past their shared deadline", () => {
    const deadline = 12_000
    const first = deriveStageBudget({ deadline, now: 0, stageDefault: 8_000, reserve: 0, floor: 100 })
    const second = deriveStageBudget({ deadline, now: first.timeoutMs, stageDefault: 5_000, reserve: 0, floor: 100 })
    expect(first.timeoutMs + second.timeoutMs).toBeLessThanOrEqual(deadline)
  })

  test("nearly exhausted deadlines return the floor and flag exhaustion", () => {
    expect(deriveStageBudget({ deadline: 12_000, now: 11_950, stageDefault: 5_000, reserve: 0, floor: 100 }))
      .toEqual({ timeoutMs: 100, budgetExhausted: true })
  })
})
