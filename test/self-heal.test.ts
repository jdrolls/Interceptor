import { describe, expect, test } from "bun:test"
import {
  decideRecovery,
  isRetryableAction,
  isTimeoutError,
  selfHealEnabled
} from "../cli/lib/self-heal"

describe("self-heal", () => {
  test("recognizes only transport timeout errors", () => {
    expect(isTimeoutError(new Error("timeout: no response for 'read' after 15s"))).toBe(true)
    expect(isTimeoutError(new Error("daemon not running. Open Chrome with the Interceptor extension loaded."))).toBe(false)
    expect(isTimeoutError("timeout: no response for 'read' after 15s")).toBe(false)
    expect(isTimeoutError(null)).toBe(false)
  })

  test("can be disabled with INTERCEPTOR_NO_AUTOHEAL", () => {
    expect(selfHealEnabled({})).toBe(true)
    expect(selfHealEnabled({ INTERCEPTOR_NO_AUTOHEAL: "1" })).toBe(false)
    expect(selfHealEnabled({ INTERCEPTOR_NO_AUTOHEAL: "true" })).toBe(false)
  })

  test("retries only read-only actions", () => {
    expect(isRetryableAction("get_a11y_tree")).toBe(true)
    expect(isRetryableAction("evaluate")).toBe(false)
    expect(isRetryableAction("click")).toBe(false)
    expect(isRetryableAction("navigate")).toBe(false)
    expect(isRetryableAction("tab_create")).toBe(false)
    expect(isRetryableAction("storage_write")).toBe(false)
  })

  test("heals only repeated timeouts and retries only safe actions", () => {
    expect(decideRecovery({ isTimeout: false, enabled: true, degraded: true, alreadyHealed: false, retryable: true })).toBe("rethrow")
    expect(decideRecovery({ isTimeout: true, enabled: false, degraded: true, alreadyHealed: false, retryable: true })).toBe("rethrow")
    expect(decideRecovery({ isTimeout: true, enabled: true, degraded: false, alreadyHealed: false, retryable: true })).toBe("rethrow")
    expect(decideRecovery({ isTimeout: true, enabled: true, degraded: true, alreadyHealed: true, retryable: true })).toBe("rethrow")
    expect(decideRecovery({ isTimeout: true, enabled: true, degraded: true, alreadyHealed: false, retryable: true })).toBe("heal-and-retry")
    expect(decideRecovery({ isTimeout: true, enabled: true, degraded: true, alreadyHealed: false, retryable: false })).toBe("heal-and-fail")
  })
})
