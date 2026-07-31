import { describe, expect, test } from "bun:test"
import {
  abandonSocketRequests,
  shouldDrainQueuedMessage,
  WS_QUEUE_MAX_AGE_MS,
} from "../daemon/request-lifecycle"

describe("daemon websocket queue draining", () => {
  const NOW = 1_000_000

  test("drains fresh pending entries and id-less messages, but skips dead or expired work", () => {
    const opts = { now: NOW, isPending: (id: string) => id === "pending", maxAgeMs: WS_QUEUE_MAX_AGE_MS }

    expect(shouldDrainQueuedMessage({ id: "pending", json: "{}", queuedAt: NOW - 1 }, opts)).toEqual({ drain: true })
    expect(shouldDrainQueuedMessage({ id: "gone", json: "{}", queuedAt: NOW - 1 }, opts)).toEqual({ drain: false, reason: "request is no longer pending" })
    expect(shouldDrainQueuedMessage({ id: "pending", json: "{}", queuedAt: NOW - WS_QUEUE_MAX_AGE_MS - 1 }, opts)).toEqual({ drain: false, reason: "expired" })
    expect(shouldDrainQueuedMessage({ id: undefined, json: "{}", queuedAt: NOW - 1 }, opts)).toEqual({ drain: true })
  })
})

describe("daemon socket disconnect", () => {
  test("abandons only requests owned by the closing socket", () => {
    const closingSocket = {}
    const otherSocket = {}
    const cleared: number[] = []
    const removed: string[] = []
    const events: unknown[] = []
    const pending = new Map([
      ["closing", { owner: closingSocket, socket: closingSocket, timer: 1 as unknown as ReturnType<typeof setTimeout>, startTime: 100, actionType: "tab_list" }],
      ["other", { owner: otherSocket, socket: otherSocket, timer: 2 as unknown as ReturnType<typeof setTimeout>, startTime: 200, actionType: "read" }],
    ])

    const abandoned = abandonSocketRequests(pending, closingSocket, {
      now: 500,
      clearTimer: timer => { cleared.push(timer as unknown as number) },
      removeQueuedRequest: id => { removed.push(id) },
      onAbandoned: event => { events.push(event) },
    })

    expect(abandoned).toBe(1)
    expect(cleared).toEqual([1])
    expect(removed).toEqual(["closing"])
    expect(events).toEqual([{ requestId: "closing", action: "tab_list", duration: 400, error: "caller disconnected before 'tab_list' completed after 400ms" }])
    expect(pending.has("closing")).toBe(false)
    expect(pending.has("other")).toBe(true)
  })

  test("abandons WebSocket caller work but preserves extension-owned work", () => {
    const callerWs = {}
    const extensionWs = {}
    const cleared: number[] = []
    const pending = new Map([
      ["caller", { owner: callerWs, socket: {}, timer: 1 as unknown as ReturnType<typeof setTimeout>, startTime: 100, actionType: "screenshot" }],
      ["extension", { owner: extensionWs, socket: {}, timer: 2 as unknown as ReturnType<typeof setTimeout>, startTime: 200, actionType: "read" }],
    ])

    const abandoned = abandonSocketRequests(pending, callerWs, {
      now: 500,
      clearTimer: timer => { cleared.push(timer as unknown as number) },
      removeQueuedRequest: () => {},
      onAbandoned: () => {},
    })

    expect(abandoned).toBe(1)
    expect(cleared).toEqual([1])
    expect(pending.has("caller")).toBe(false)
    expect(pending.has("extension")).toBe(true)
  })
})
