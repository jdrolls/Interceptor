/**
 * cli/lib/browser-binding.ts — answer "which browser binary is Interceptor
 * actually talking to right now?"
 *
 * `status` used to answer a weaker question: which browsers have a native
 * messaging manifest on disk. That is a statement about installation, not about
 * this session — a machine with manifests in both Chrome and Helium got the
 * same answer no matter which one was serving the extension, which is exactly
 * the confusion dora-cc#1377 was filed for.
 *
 * The authoritative fact is the TCP peer on the daemon's WebSocket port: the
 * extension is the only thing that connects to it, and the process holding that
 * socket IS the browser. Resolve the peer pid with lsof, resolve the pid to its
 * executable with ps, and the answer is a path — not a guess.
 *
 * Parsing is split out as pure functions so the classification can be tested
 * without a Mac, a browser, or lsof.
 */

import { existsSync } from "node:fs"
import { WS_PORT } from "../../shared/platform"
import {
  BROWSERS,
  browserPolicyVerdict,
  browserSpec,
  classifyExecPath,
  isHelperExecutable,
  nativeMessagingManifestPath,
  PREFERRED_BROWSER_ENV,
  type BrowserId,
} from "../../shared/browsers"
import { findDaemonPids } from "./daemon-health"

export type LsofPeer = { pid: number; command: string }

/**
 * Parse `lsof -F pcn` field output.
 *
 * Field output is a flat stream of one-letter-tagged lines where `p` opens a
 * process block and `c` names its command; file blocks (`f`/`n`) follow. One
 * entry per distinct pid, in the order lsof emitted them.
 */
export function parseLsofFieldOutput(output: string): LsofPeer[] {
  const peers: LsofPeer[] = []
  const seen = new Set<number>()
  let pid: number | null = null
  let command = ""

  const flush = () => {
    if (pid !== null && !seen.has(pid)) {
      seen.add(pid)
      peers.push({ pid, command })
    }
  }

  for (const line of output.split("\n")) {
    if (!line) continue
    const tag = line[0]
    const value = line.slice(1)
    if (tag === "p") {
      flush()
      const parsed = Number.parseInt(value, 10)
      pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
      command = ""
    } else if (tag === "c" && pid !== null) {
      command = value
    }
  }
  flush()
  return peers
}

/**
 * Choose the browser end of the connection.
 *
 * Both ends of a loopback socket show up in the same lsof listing, so the
 * daemon has to be excluded by pid — matching on the command name would break
 * the moment someone renames the binary. A peer that classifies to a known
 * browser wins outright; otherwise the first non-daemon peer is returned so an
 * UNKNOWN browser is still reported by path rather than silently dropped.
 */
export function pickBrowserPeer(peers: readonly LsofPeer[], excludePids: readonly number[]): LsofPeer | null {
  const candidates = peers.filter(p => !excludePids.includes(p.pid))
  if (candidates.length === 0) return null
  const known = candidates.find(p => classifyExecPath(p.command) !== null)
  return known ?? candidates[0]
}

export type BoundBrowser = {
  pid: number
  /** Absolute path of the executable holding the socket, or the lsof command name when ps failed. */
  execPath: string
  /** The main app binary for `id`, when the peer turned out to be a helper process. */
  binPath: string | null
  id: BrowserId | null
  label: string
}

async function runCapture(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return output
  } catch {
    return null
  }
}

/** Full executable path for a pid (`ps -o comm=` reports the path on macOS). */
export async function execPathForPid(pid: number): Promise<string | null> {
  const output = await runCapture(["ps", "-p", String(pid), "-o", "comm="])
  const path = output?.trim()
  return path ? path : null
}

/**
 * Resolve the browser currently connected to the daemon's WebSocket port.
 * Returns null when nothing is connected or when the platform has no lsof —
 * an unresolvable binding is reported as unknown, never as compliant.
 */
export async function resolveBoundBrowser(opts: {
  port?: number
  excludePids?: readonly number[]
} = {}): Promise<BoundBrowser | null> {
  const port = opts.port ?? WS_PORT
  const output = await runCapture([
    "lsof", "-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "+c", "0", "-F", "pcn",
  ])
  if (!output) return null

  const peer = pickBrowserPeer(parseLsofFieldOutput(output), opts.excludePids ?? [])
  if (!peer) return null

  const execPath = (await execPathForPid(peer.pid)) ?? peer.command
  const id = classifyExecPath(execPath)
  return {
    pid: peer.pid,
    execPath,
    binPath: id && isHelperExecutable(execPath) ? browserSpec(id).binPath : null,
    id,
    label: id ? browserSpec(id).label : "unknown browser",
  }
}

/** Which browsers have an Interceptor native messaging manifest installed. */
export function installedManifestBrowsers(home: string, exists: (path: string) => boolean): BrowserId[] {
  return BROWSERS.filter(spec => exists(nativeMessagingManifestPath(spec.id, home))).map(spec => spec.id)
}

/** The single line status/doctor print. Always names a binary when it has one. */
export function describeBinding(bound: BoundBrowser | null): string {
  if (!bound) return "not bound — no browser is connected to the daemon"
  const binary = bound.binPath ?? bound.execPath
  const viaHelper = bound.binPath ? ` via helper ${bound.execPath}` : ""
  return `${bound.label} (pid ${bound.pid}) — ${binary}${viaHelper}`
}

export type BrowserBlock = {
  configured: BrowserId[]
  bound: BoundBrowser | null
  preferred: BrowserId | null
  policyOk: boolean
  policyDetail: string
}

/**
 * The browser facts `status` and `doctor` both report. Shared so the two can
 * never disagree about which browser is bound — the drift that let a Chrome
 * binding pass unnoticed for a whole session (dora-cc#1377).
 */
export async function buildBrowserBlock(): Promise<BrowserBlock> {
  const configured = installedManifestBrowsers(process.env.HOME || "", existsSync)
  const bound = await resolveBoundBrowser({ excludePids: await findDaemonPids() })
  // Preference is computed over browsers PRESENT ON THE MACHINE, not over
  // browsers that already have a manifest. The #1377 failure state is exactly
  // "Helium is installed but only Chrome has a manifest" — scoring that against
  // the manifest list would rubber-stamp it as compliant.
  const installed = [...new Set([...installedAppBrowsers(), ...configured])]
  const verdict = browserPolicyVerdict({
    bound: bound?.id ?? null,
    installed,
    override: process.env[PREFERRED_BROWSER_ENV] ?? null,
  })
  return {
    configured,
    bound,
    preferred: verdict.preferred,
    policyOk: verdict.ok,
    policyDetail: verdict.detail,
  }
}

/**
 * Browsers present in /Applications. Used as the preference input only when no
 * manifest is installed anywhere — otherwise a first-ever install would report
 * "no preference" and the policy check would never fire.
 */
export function installedAppBrowsers(): BrowserId[] {
  return BROWSERS.filter(spec => existsSync(spec.appPath)).map(spec => spec.id)
}
