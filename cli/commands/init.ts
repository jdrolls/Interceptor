/**
 * cli/commands/init.ts — interceptor init
 *
 * Bootstraps the local runtime explicitly: spawns the daemon (if not already
 * running), then prints the same status output `interceptor status` would
 * emit. Idempotent — re-running when the daemon is already running just
 * prints the status; nothing is restarted.
 *
 * `init` and `status` share `lib/status-renderer.ts` so their output format
 * never drifts. After bootstrap actions complete, init invokes the same
 * renderer status uses.
 *
 * Explicitly does NOT touch the browser: no tab creation, no content-script
 * injection, no extension probing (unless `--verbose` is passed, in which
 * case the same probe `status --verbose` runs).
 */

import { ensureDaemon } from "../daemon-spawn"
import {
  readStatusSnapshot,
  detectMacOSDefaultBrowser,
  formatStatus,
  snapshotToJson,
  type StatusSnapshot,
} from "../lib/status-renderer"
import { buildBrowserBlock } from "../lib/browser-binding"
import type { BrowserId } from "../../shared/browsers"
import { sendCommand } from "../transport"

async function probe(): Promise<{ reachable: boolean; reason?: string }> {
  try {
    const resp = await Promise.race([
      sendCommand({ type: "tab_list" }, undefined),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("probe timed out after 2s")), 2000)
      ),
    ])
    const result = resp.result
    if (!result.success) return { reachable: false, reason: result.error || "tab_list failed" }
    const tabs = (result.data as Array<unknown>) || []
    if (Array.isArray(tabs) && tabs.length > 0) return { reachable: true }
    return { reachable: false, reason: "no tabs in interceptor group; run 'interceptor open <url>' to verify" }
  } catch (err) {
    return { reachable: false, reason: (err as Error).message }
  }
}

export async function runInitCommand(filtered: string[]): Promise<null> {
  const verbose = filtered.includes("--verbose") || filtered.includes("--explain") || filtered.includes("-v")
  const jsonMode = filtered.includes("--json")

  // Idempotent bootstrap. ensureDaemon writes to stderr if it actually spawns;
  // when the daemon is already running it returns silently.
  await ensureDaemon()

  const snap: StatusSnapshot = readStatusSnapshot()

  // Browser block (#52 + dora-cc#1377) — the binding is reported unconditionally
  // on macOS; `init` bootstraps the daemon, so naming the browser it came up
  // against is part of "ready".
  if (process.platform === "darwin") {
    const block = await buildBrowserBlock()
    const sysDefault = verbose ? detectMacOSDefaultBrowser() : null
    let matches: boolean | null = null
    if (sysDefault && block.configured.length > 0) {
      matches = block.configured.includes(sysDefault as BrowserId)
    }
    snap.browser = {
      configured: block.configured,
      systemDefault: sysDefault,
      matches,
      bound: block.bound,
      preferred: block.preferred,
      policyOk: block.policyOk,
      policyDetail: block.policyDetail,
    }
  }
  if (verbose && snap.daemon) {
    const p = await probe()
    snap.extension = { probed: true, ...p }
  }

  if (jsonMode) {
    console.log(JSON.stringify(snapshotToJson(snap), null, 2))
  } else {
    if (!verbose) {
      // Default init output: tag the bootstrap action visibly above the
      // shared status block so the user sees the difference between
      // `init` (action then report) and `status` (report only).
      console.log(snap.daemon ? "ready." : "(daemon not running — see hint below)")
      console.log("")
    }
    console.log(formatStatus(snap, { verbose }))
  }
  return null
}
