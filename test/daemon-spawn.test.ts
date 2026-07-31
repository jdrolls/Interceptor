import { describe, expect, test } from "bun:test"
import { ensureDaemon } from "../cli/daemon-spawn"

const SOCKET = "/tmp/interceptor-test.sock"
const PID = "/tmp/interceptor-test.pid"

function noOpDependencies() {
  return {
    socketPath: SOCKET,
    pidPath: PID,
    wsPort: 19222,
    isWin: false,
    writeStderr: () => {},
    fatal: (message: string): never => { throw new Error(message) },
  }
}

describe("ensureDaemon functional liveness", () => {
  test("a stale pidfile with a bound port and live socket neither spawns nor unlinks", async () => {
    const unlinked: string[] = []
    let spawns = 0

    await ensureDaemon({
      ...noOpDependencies(),
      isWsPortBound: async () => true,
      probeSocket: async () => ({ connected: true }),
      exists: () => true,
      unlink: (path) => { unlinked.push(path) },
      spawnDaemon: () => { spawns++ },
    })

    expect(spawns).toBe(0)
    expect(unlinked).not.toContain(SOCKET)
  })

  test("unlinks a proven-dead socket before spawning", async () => {
    const unlinked: string[] = []
    let spawns = 0
    let probes = 0

    await ensureDaemon({
      ...noOpDependencies(),
      isWsPortBound: async () => false,
      probeSocket: async () => {
        probes++
        return probes === 1 ? { connected: false, code: "ECONNREFUSED" } : { connected: true }
      },
      exists: (path) => path === SOCKET,
      unlink: (path) => { unlinked.push(path) },
      findBinary: () => "/fake/interceptor-daemon",
      spawnDaemon: () => { spawns++ },
      sleep: async () => {},
    })

    expect(unlinked).toContain(SOCKET)
    expect(spawns).toBe(1)
  })

  test("refuses to spawn or unlink when another daemon owns the bound port", async () => {
    const unlinked: string[] = []
    const stderr: string[] = []
    let spawns = 0

    await expect(ensureDaemon({
      ...noOpDependencies(),
      isWsPortBound: async () => true,
      probeSocket: async () => ({ connected: false, code: "ECONNREFUSED" }),
      exists: () => true,
      unlink: (path) => { unlinked.push(path) },
      readPidHint: () => "999",
      spawnDaemon: () => { spawns++ },
      writeStderr: (message) => { stderr.push(message) },
    })).rejects.toThrow("another daemon owns :19222")

    expect(spawns).toBe(0)
    expect(unlinked).not.toContain(SOCKET)
    expect(stderr.join("")).toContain("CLI socket is stale")
  })
})
