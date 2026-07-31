/**
 * cli/daemon-spawn.ts — findDaemonBinary and ensureDaemon auto-start logic
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { IS_WIN, SOCKET_PATH, PID_PATH, WS_PORT } from "../shared/platform"

const DAEMON_BINARY = IS_WIN ? "interceptor-daemon.exe" : "interceptor-daemon"
const CONNECT_TIMEOUT_MS = 500

export type SocketProbe = { connected: boolean; code?: string }

function connectWithTimeout(options: { hostname: string; port: number } | { unix: string }): Promise<SocketProbe> {
  return new Promise((resolve) => {
    let settled = false
    let socket: Bun.Socket<undefined> | null = null
    const finish = (probe: SocketProbe) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket?.end() } catch {}
      resolve(probe)
    }
    const timer = setTimeout(() => finish({ connected: false, code: "ETIMEDOUT" }), CONNECT_TIMEOUT_MS)
    const handlers: Bun.SocketHandler<undefined> = {
      open(opened) {
        socket = opened
        finish({ connected: true })
      },
      connectError(_socket, err) {
        finish({ connected: false, code: (err as NodeJS.ErrnoException).code })
      },
      error(_socket, err) {
        finish({ connected: false, code: (err as NodeJS.ErrnoException).code })
      },
      close() {},
      data() {},
    }
    try {
      const connection = "hostname" in options
        ? Bun.connect({ hostname: options.hostname, port: options.port, socket: handlers })
        : Bun.connect({ unix: options.unix, socket: handlers })
      void connection.catch((err: NodeJS.ErrnoException) => {
        finish({ connected: false, code: err.code })
      })
    } catch (err) {
      finish({ connected: false, code: (err as NodeJS.ErrnoException).code })
    }
  })
}

/** True when a process accepts TCP connections on the extension's WS port. */
export async function isWsPortBound(port = WS_PORT): Promise<boolean> {
  return (await connectWithTimeout({ hostname: "127.0.0.1", port })).connected
}

/** True when the daemon's Unix socket accepts a connection. */
export async function canConnectSocket(path = SOCKET_PATH): Promise<boolean> {
  if (IS_WIN) return false
  return (await connectWithTimeout({ unix: path })).connected
}

async function probeSocket(path: string): Promise<SocketProbe> {
  if (IS_WIN) return { connected: false, code: "ENOENT" }
  return connectWithTimeout({ unix: path })
}

export function findDaemonBinary(): string | null {
  const candidates: string[] = []
  const exePath = resolve(process.execPath || process.argv[0] || "")
  const exeDir = dirname(exePath)
  candidates.push(join(exeDir, "..", "daemon", DAEMON_BINARY))
  candidates.push(join(exeDir, DAEMON_BINARY))
  candidates.push(join(exeDir, "daemon", DAEMON_BINARY))
  candidates.push(resolve("daemon", DAEMON_BINARY))
  candidates.push(resolve("daemon", "interceptor-daemon"))
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Ensure the daemon is running, spawning it only when neither of its functional
 * listener endpoints is alive. The WebSocket port is authoritative because it
 * is the endpoint to which the extension is attached.
 */
export type EnsureDaemonDependencies = {
  isWsPortBound?: () => Promise<boolean>
  probeSocket?: (path: string) => Promise<SocketProbe>
  socketPath?: string
  pidPath?: string
  wsPort?: number
  isWin?: boolean
  exists?: (path: string) => boolean
  unlink?: (path: string) => void
  readPidHint?: () => string
  findBinary?: () => string | null
  spawnDaemon?: (binary: string) => void
  sleep?: (ms: number) => Promise<unknown>
  writeStderr?: (message: string) => void
  fatal?: (message: string) => never
}

/**
 * Dependencies are optional production defaults, with probes and filesystem
 * operations injectable so liveness behavior can be tested without a daemon.
 */
export async function ensureDaemon(deps: EnsureDaemonDependencies = {}): Promise<void> {
  const socketPath = deps.socketPath ?? SOCKET_PATH
  const pidPath = deps.pidPath ?? PID_PATH
  const wsPort = deps.wsPort ?? WS_PORT
  const isWin = deps.isWin ?? IS_WIN
  const portProbe = deps.isWsPortBound ?? (() => isWsPortBound(wsPort))
  const socketProbe = deps.probeSocket ?? probeSocket
  const pathExists = deps.exists ?? existsSync
  const unlink = deps.unlink ?? unlinkSync
  const readPidHint = deps.readPidHint ?? (() => {
    try { return readFileSync(pidPath, "utf-8").trim().split("\n")[0] || "unknown" } catch { return "unknown" }
  })
  const findBinary = deps.findBinary ?? findDaemonBinary
  const spawnDaemon = deps.spawnDaemon ?? ((binary: string) => {
    const child = Bun.spawn([binary, "--standalone"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    })
    child.unref()
  })
  const sleep = deps.sleep ?? Bun.sleep
  const writeStderr = deps.writeStderr ?? ((message: string) => process.stderr.write(message))
  // Explicitly annotated so TypeScript treats a fatal() call as terminating
  // control flow; without the annotation it will not narrow past this point.
  const fatal: (message: string) => never = deps.fatal ?? ((message: string): never => {
    console.error(message)
    process.exit(1)
  })

  const wsBound = await portProbe()
  const socket = await socketProbe(socketPath)

  if (wsBound) {
    if (!socket.connected) {
      const message = `another daemon owns :${wsPort} (pid ${readPidHint()}) but the CLI socket is stale — run 'interceptor doctor --fix'`
      writeStderr(`${message}\n`)
      throw new Error(message)
    }
    return
  }

  if (socket.connected) return

  // A filesystem entry is not evidence of a daemon. Reap it only after a
  // connection refusal / disappearance, never just because a pidfile is stale.
  if (!isWin && pathExists(socketPath) && (socket.code === "ECONNREFUSED" || socket.code === "ENOENT")) {
    try { unlink(socketPath) } catch {}
  }

  try { unlink(pidPath) } catch {}

  const resolvedDaemon = findBinary()
  if (!resolvedDaemon) {
    fatal("error: daemon not running and interceptor-daemon binary not found. Open Chrome with the Interceptor extension loaded, or build the daemon.")
  }

  writeStderr("daemon not running — spawning...\n")
  spawnDaemon(resolvedDaemon)

  for (let i = 0; i < 20; i++) {
    await sleep(250)
    if ((await socketProbe(socketPath)).connected || (isWin && pathExists(pidPath))) return
  }

  if (!isWin) {
    fatal("error: daemon failed to start. Check /tmp/interceptor.log")
  }
}
