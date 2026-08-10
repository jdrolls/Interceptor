/**
 * test/screenshot-cli-exit-codes.test.ts — end-to-end CLI contract for
 * dora-cc#1383: a screenshot that failed must exit non-zero, an unknown flag
 * must exit non-zero without printing an image, and the base64 payload must
 * stay off stdout unless asked for.
 *
 * Driven against a stub daemon on an isolated socket (INTERCEPTOR_SOCKET_PATH),
 * so no real daemon, browser, or extension is involved and a developer's live
 * interceptor session is never disturbed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "bun"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SOCK = join(tmpdir(), `interceptor-1383-${process.pid}.sock`)
const PID = join(tmpdir(), `interceptor-1383-${process.pid}.pid`)

// Reply the stub daemon sends for the next CLI request.
let nextResult: Record<string, unknown> = { success: true }
let server: ReturnType<typeof Bun.listen> | null = null

function frame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf-8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.byteLength, 0)
  return Buffer.concat([header, body])
}

beforeAll(() => {
  try { if (existsSync(SOCK)) unlinkSync(SOCK) } catch {}
  writeFileSync(PID, `${process.pid}\nstub\n`)
  server = Bun.listen({
    unix: SOCK,
    socket: {
      data(socket, raw) {
        // Requests are small enough to arrive in one chunk on a unix socket.
        const len = Buffer.from(raw).readUInt32LE(0)
        const json = Buffer.from(raw).subarray(4, 4 + len).toString("utf-8")
        const { id } = JSON.parse(json) as { id: string }
        socket.write(frame(JSON.stringify({ id, result: nextResult })))
      },
      open() {},
      close() {},
      error() {},
    },
  })
})

afterAll(() => {
  server?.stop(true)
  try { if (existsSync(SOCK)) unlinkSync(SOCK) } catch {}
  try { if (existsSync(PID)) unlinkSync(PID) } catch {}
})

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // --no-ws pins the CLI to the unix socket this test owns; without it the
  // screenshot command auto-routes to the WebSocket transport.
  const proc = spawn({
    cmd: ["bun", "run", "cli/index.ts", ...args, "--no-ws"],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, INTERCEPTOR_SOCKET_PATH: SOCK, INTERCEPTOR_PID_PATH: PID },
  })
  const timer = setTimeout(() => proc.kill(), 30_000)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  clearTimeout(timer)
  return { code, stdout, stderr }
}

const BIG_DATA_URL = `data:image/jpeg;base64,${"QUJD".repeat(2000)}`

describe("interceptor screenshot exit-code contract (dora-cc#1383)", () => {
  test("an unknown flag exits non-zero, names the flag, and prints no image", async () => {
    nextResult = { success: true, data: { dataUrl: BIG_DATA_URL, format: "jpeg", size: 6000 } }
    const { code, stdout, stderr } = await runCli([
      "screenshot", "--format", "jpeg", "--target-max-long-edge", "200", "--out", "/tmp/x.png",
    ])
    expect(code).not.toBe(0)
    expect(stderr).toContain("--out")
    expect(stderr).toContain("--save")
    expect(stdout).not.toContain("data:image")
    expect(stdout.length).toBeLessThan(200)
  })

  test("a failed capture exits non-zero instead of printing 'error:' at exit 0", async () => {
    nextResult = {
      success: false,
      error: "failed to inject screenshot-runner.js: Cannot access a chrome:// URL",
    }
    const { code, stdout, stderr } = await runCli(["screenshot"])
    expect(code).not.toBe(0)
    expect(stdout + stderr).toContain("Cannot access a chrome:// URL")
  })

  test("a refused drifted --pixel capture exits non-zero carrying the guard message", async () => {
    nextResult = {
      success: false,
      error:
        "target tab 1957911780 (https://blog.example/staged) is not the visible tab; " +
        "refusing to silently capture tab 1957911774 (file:///tmp/lifeos-bench-report.html) instead — " +
        "pass --tab explicitly, run 'interceptor open <url>', activate the target tab, " +
        "or set INTERCEPTOR_ALLOW_TAB_DRIFT=1",
      data: { layer: "captureTarget" },
    }
    const { code, stdout, stderr } = await runCli(["screenshot", "--pixel"])
    expect(code).not.toBe(0)
    const out = stdout + stderr
    expect(out).toContain("refusing to silently capture tab 1957911774")
    expect(out).toContain("INTERCEPTOR_ALLOW_TAB_DRIFT=1")
  })

  test("the base64 payload is withheld from stdout by default", async () => {
    nextResult = {
      success: true,
      data: { dataUrl: BIG_DATA_URL, format: "jpeg", size: 6000, tabId: 42, url: "https://example.com/" },
    }
    const { code, stdout } = await runCli(["screenshot", "--json"])
    expect(code).toBe(0)
    expect(stdout).not.toContain("data:image")
    expect(stdout).toContain("dataUrlOmitted")
    // Ask 2: the capture names the page it came from.
    expect(stdout).toContain("https://example.com/")
    expect(stdout).toContain("42")
  })

  test("--stdout opts back in to the base64 payload", async () => {
    nextResult = { success: true, data: { dataUrl: BIG_DATA_URL, format: "jpeg", size: 6000 } }
    const { code, stdout } = await runCli(["screenshot", "--stdout", "--json"])
    expect(code).toBe(0)
    expect(stdout).toContain("data:image/jpeg;base64,")
  })

  test("a capture that dropped lazy images warns on stderr and still exits 0", async () => {
    nextResult = {
      success: true,
      data: {
        dataUrl: BIG_DATA_URL,
        format: "png",
        size: 6000,
        tabId: 7,
        url: "https://example.com/post",
        lazyImages: { lazyTotal: 2, lazyNotRendered: 2, sample: ["/img/a.png", "/img/b.png"] },
      },
    }
    const { code, stderr } = await runCli(["screenshot", "--json"])
    expect(code).toBe(0)
    expect(stderr).toContain("2 lazy-loaded images")
    expect(stderr).toContain("/img/a.png")
  })

  test("non-screenshot commands still emit their payload unchanged", async () => {
    // The stdout gate is scoped to `screenshot`; `canvas read` and friends keep
    // returning their dataUrl so existing workflows are untouched.
    nextResult = { success: true, data: { dataUrl: BIG_DATA_URL, format: "jpeg" } }
    const { code, stdout } = await runCli(["canvas", "read", "0", "--json"])
    expect(code).toBe(0)
    expect(stdout).toContain("data:image/jpeg;base64,")
  })
})
