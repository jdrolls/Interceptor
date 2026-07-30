export type WsQueuedMessage = {
  id: string | undefined
  json: string
  queuedAt: number
}

export const WS_QUEUE_MAX_AGE_MS = 60_000

export function shouldDrainQueuedMessage(
  entry: WsQueuedMessage,
  opts: { now: number; isPending: (id: string) => boolean; maxAgeMs: number }
): { drain: boolean; reason?: string } {
  if (opts.now - entry.queuedAt > opts.maxAgeMs) {
    return { drain: false, reason: "expired" }
  }
  if (entry.id && !opts.isPending(entry.id)) {
    return { drain: false, reason: "request is no longer pending" }
  }
  return { drain: true }
}

type OwnedRequest<Owner> = {
  owner: Owner
  socket: unknown
  timer: ReturnType<typeof setTimeout>
  startTime: number
  actionType: string
}

export function abandonSocketRequests<Request extends OwnedRequest<unknown>>(
  pendingRequests: Map<string, Request>,
  owner: unknown,
  opts: {
    now: number
    clearTimer: (timer: ReturnType<typeof setTimeout>) => void
    removeQueuedRequest: (id: string) => void
    onAbandoned: (event: { requestId: string; action: string; duration: number; error: string }) => void
  }
): number {
  let abandoned = 0
  for (const [requestId, request] of pendingRequests) {
    if (request.owner !== owner) continue

    opts.clearTimer(request.timer)
    const duration = opts.now - request.startTime
    const error = `caller disconnected before '${request.actionType}' completed after ${duration}ms`
    opts.onAbandoned({ requestId, action: request.actionType, duration, error })
    pendingRequests.delete(requestId)
    opts.removeQueuedRequest(requestId)
    abandoned++
  }
  return abandoned
}
