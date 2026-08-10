/**
 * test/install-modes.test.ts
 *
 * Asserts the two install modes produce the expected step lists under
 * INSTALL_DRY_RUN=1 (or --dry-run). These tests do NOT modify any system
 * state — they shell out to scripts/install.sh with the dry-run flag and
 * inspect its stdout.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const INSTALL_SCRIPT = resolve(REPO_ROOT, "scripts/install.sh")

function runInstallDryRun(args: string[]): { stdout: string; status: number; stderr: string } {
  const proc = spawnSync("bash", [INSTALL_SCRIPT, "--dry-run", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, INSTALL_DRY_RUN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  })
  return {
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
    status: proc.status ?? -1,
  }
}

describe("install modes — dry-run", () => {
  test("--browser-only prints browser steps but never bridge steps", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only", "--chrome"])
    expect(status).toBe(0)
    expect(stdout).toContain("Mode: browser-only")
    expect(stdout).toContain("Browser: chrome")
    expect(stdout).toContain("DRY RUN")
    expect(stdout).toContain("[browser] Generating native messaging manifest")
    expect(stdout).toContain("[browser] Installing native messaging symlink")
    expect(stdout).toContain("Done. Installed in browser-only mode.")

    // The bridge MUST NOT be referenced in the browser-only step list. The
    // browser-only contract is that browser-only installs never mention
    // LaunchAgent or install-bridge.sh in their executed steps.
    expect(stdout).not.toContain("install-bridge.sh")
    expect(stdout).not.toContain("com.interceptor.bridge.plist")
    expect(stdout).not.toContain("[bridge]")
  })

  test("--full prints both browser steps and bridge steps", () => {
    const { stdout, status } = runInstallDryRun(["--full", "--chrome"])
    expect(status).toBe(0)
    expect(stdout).toContain("Mode: full")
    expect(stdout).toContain("Browser: chrome")
    expect(stdout).toContain("DRY RUN")
    expect(stdout).toContain("[browser] Generating native messaging manifest")
    expect(stdout).toContain("[browser] Installing native messaging symlink")
    expect(stdout).toContain("[bridge] Chaining into install-bridge.sh")
    expect(stdout).toContain("com.interceptor.bridge.plist")
    expect(stdout).toContain("DRY-RUN complete (full mode)")
  })

  test("--browser-only and --full are mutually exclusive", () => {
    const { status, stderr } = runInstallDryRun(["--browser-only", "--full"])
    expect(status).not.toBe(0)
    expect(stderr).toContain("mutually exclusive")
  })

  test("unknown flags exit non-zero with usage hint", () => {
    const { status, stderr } = runInstallDryRun(["--bogus-flag"])
    expect(status).not.toBe(0)
    expect(stderr).toContain("Unknown flag")
  })

  test("--browser-only --skip-extension still does only browser steps", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only", "--chrome", "--skip-extension"])
    expect(status).toBe(0)
    expect(stdout).toContain("Mode: browser-only")
    expect(stdout).toContain("Skipping extension loading")
    expect(stdout).not.toContain("install-bridge.sh")
  })

  test("non-interactive (no flags) defaults to platform-appropriate mode", () => {
    // With INSTALL_DRY_RUN=1 the script picks the platform default rather than
    // blocking on stdin. On Darwin → full, elsewhere → browser-only.
    const { stdout, status } = runInstallDryRun([])
    expect(status).toBe(0)
    if (process.platform === "darwin") {
      expect(stdout).toContain("Mode: full")
    } else {
      expect(stdout).toContain("Mode: browser-only")
    }
  })
})

describe("install browser selection — dry-run", () => {
  test("--chrome installs only the Chrome native-messaging path", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only", "--chrome"])
    expect(status).toBe(0)
    expect(stdout).toContain("Browser: chrome")
    expect(stdout).toContain("Google/Chrome/NativeMessagingHosts")
    expect(stdout).not.toContain("BraveSoftware/Brave-Browser/NativeMessagingHosts")
  })

  test("--brave installs only the Brave native-messaging path", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only", "--brave"])
    expect(status).toBe(0)
    expect(stdout).toContain("Browser: brave")
    expect(stdout).toContain("BraveSoftware/Brave-Browser/NativeMessagingHosts")
    expect(stdout).not.toContain("Google/Chrome/NativeMessagingHosts")
  })

  test("--helium installs only the Helium native-messaging path", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only", "--helium"])
    expect(status).toBe(0)
    expect(stdout).toContain("Browser: helium")
    expect(stdout).toContain("net.imput.helium/NativeMessagingHosts")
    expect(stdout).not.toContain("Google/Chrome/NativeMessagingHosts")
    expect(stdout).not.toContain("BraveSoftware/Brave-Browser/NativeMessagingHosts")
  })

  /**
   * dora-cc#1377: the non-interactive default used to be a hard-coded "chrome",
   * which is how a Helium machine silently got its manifest written into Chrome.
   * It now resolves by preference order over what is installed.
   */
  test("non-interactive default resolves by preference order, not a hard-coded chrome", () => {
    const { stdout, status } = runInstallDryRun(["--browser-only"])

    if (process.platform !== "darwin") {
      // No /Applications to resolve against — the script must say so, not guess.
      expect(status).not.toBe(0)
      return
    }

    expect(status).toBe(0)
    expect(stdout).not.toContain("defaulting to 'chrome'")

    const installed = [
      { id: "helium", app: "/Applications/Helium.app" },
      { id: "brave", app: "/Applications/Brave Browser.app" },
      { id: "chrome", app: "/Applications/Google Chrome.app" },
    ].filter(b => existsSync(b.app))

    // Preference order is helium > brave > chrome; the first installed one wins.
    expect(stdout).toContain(`Browser: ${installed[0].id}`)
  })
})
