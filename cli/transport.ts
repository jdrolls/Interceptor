/**
 * cli/transport.ts — sendCommand (Unix socket / TCP) and sendCommandWs (WebSocket)
 */

import { appendFile } from "node:fs"
import { EVENTS_PATH, IPC_PORT, IS_WIN, SOCKET_PATH, WS_PORT } from "../shared/platform"
import type { TabResolvedVia } from "../shared/tab-provenance"

export const INTERCEPTOR_TIMEOUT_MS = parseInt(process.env.INTERCEPTOR_TIMEOUT || "15000")

export type Action = { type: string; [key: string]: unknown }
export type DaemonResult = {
  success: boolean
  error?: string
  data?: unknown
  tabId?: number
  tabResolvedVia?: "stored" | "active-cold" | "active-drift"
  resolvedTabUrl?: string
}
export type DaemonResponse = {
  id: string
  result: DaemonResult
}

function recordTimeout(action: Action, requestId: string, error: string): void {
  try {
    appendFile(EVENTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), event: "request_timeout", requestId, action: action.type, error }) + "\n", () => {})
  } catch {}
}

function allowTabDrift(): boolean {
  const value = process.env.INTERCEPTOR_ALLOW_TAB_DRIFT?.toLowerCase()
  return value === "1" || value === "true"
}

export function sendCommand(action: Action, tabId?: number): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const shortId = id.slice(0, 8)
    process.stderr.write(`[${shortId}] → ${action.type}\n`)
    let buffer = Buffer.alloc(0)
    let resolved = false
    let socketRef: Bun.Socket<undefined> | null = null

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        if (socketRef) try { socketRef.end() } catch {}
        const error = `timeout: no response for '${action.type}' after ${INTERCEPTOR_TIMEOUT_MS / 1000}s. Ensure Chrome/Brave is open with the Interceptor extension loaded.`
        recordTimeout(action, id, error)
        reject(new Error(error))
      }
    }, INTERCEPTOR_TIMEOUT_MS)

    const socketHandlers: Bun.SocketHandler<undefined> = {
      open(socket: Bun.Socket<undefined>) {
        socketRef = socket
        const payload = JSON.stringify({ id, action, ...(tabId !== undefined && { tabId }), ...(allowTabDrift() && { allowTabDrift: true }) })
        const encoded = Buffer.from(payload, "utf-8")
        const header = Buffer.alloc(4)
        header.writeUInt32LE(encoded.byteLength, 0)
        socket.write(Buffer.concat([header, encoded]))
      },
      data(socket: Bun.Socket<undefined>, raw: Buffer<ArrayBufferLike>) {
        buffer = Buffer.concat([buffer, Buffer.from(raw)])
        if (buffer.length >= 4) {
          const msgLen = buffer.readUInt32LE(0)
          if (msgLen > 0 && msgLen <= 1024 * 1024 && buffer.length >= 4 + msgLen) {
            const json = buffer.subarray(4, 4 + msgLen).toString("utf-8")
            clearTimeout(timer)
            try {
              resolved = true
              resolve(JSON.parse(json) as DaemonResponse)
            } catch {
              resolved = true
              reject(new Error("invalid response from daemon"))
            }
            socket.end()
          }
        }
      },
      close(_socket: Bun.Socket<undefined>) {
        clearTimeout(timer)
        if (!resolved) {
          reject(new Error("connection closed before response"))
        }
      },
      connectError(_socket: Bun.Socket<undefined>, _err: Error) {
        clearTimeout(timer)
        reject(new Error("daemon not running. Open Chrome with the Interceptor extension loaded."))
      },
      error(_socket: Bun.Socket<undefined>, err: Error) {
        clearTimeout(timer)
        reject(err)
      }
    }

    const connectPromise = IS_WIN
      ? Bun.connect({ hostname: "127.0.0.1", port: IPC_PORT, socket: socketHandlers })
      : Bun.connect({ unix: SOCKET_PATH, socket: socketHandlers })

    void connectPromise.catch(() => {})
  })
}

export function sendCommandWs(action: Action, tabId?: number): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const shortId = id.slice(0, 8)
    process.stderr.write(`[${shortId}] →ws ${action.type}\n`)

    const timer = setTimeout(() => {
      const error = `timeout: no response for '${action.type}' after ${INTERCEPTOR_TIMEOUT_MS / 1000}s via WebSocket.`
      recordTimeout(action, id, error)
      reject(new Error(error))
    }, INTERCEPTOR_TIMEOUT_MS)

    const ws = new WebSocket(`ws://localhost:${WS_PORT}`)
    ws.onopen = () => {
      ws.send(JSON.stringify({ id, action, ...(tabId !== undefined && { tabId }), ...(allowTabDrift() && { allowTabDrift: true }) }))
    }
    ws.onmessage = (event) => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(typeof event.data === "string" ? event.data : "") as DaemonResponse)
      } catch {
        reject(new Error("invalid response from daemon via WebSocket"))
      }
      ws.close()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("WebSocket connection failed to daemon"))
    }
    ws.onclose = () => {
      clearTimeout(timer)
    }
  })
}
