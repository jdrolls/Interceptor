/**
 * test/browser-binding.test.ts — dora-cc#1377.
 *
 * Covers the two questions `status`/`doctor` now answer: which browser binary
 * is on the other end of the daemon's WebSocket, and whether that browser is
 * the one the Helium-first policy asks for.
 */

import { describe, expect, test } from "bun:test"
import {
  BROWSER_PREFERENCE,
  browserPolicyVerdict,
  classifyExecPath,
  isHelperExecutable,
  nativeMessagingManifestPath,
  preferredBrowser,
} from "../shared/browsers"
import {
  describeBinding,
  installedManifestBrowsers,
  parseLsofFieldOutput,
  pickBrowserPeer,
} from "../cli/lib/browser-binding"

const HELIUM_BIN = "/Applications/Helium.app/Contents/MacOS/Helium"
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const BRAVE_BIN = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
const CHROME_HELPER =
  "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"

describe("classifyExecPath", () => {
  test("classifies each registry browser from its main binary", () => {
    expect(classifyExecPath(HELIUM_BIN)).toBe("helium")
    expect(classifyExecPath(CHROME_BIN)).toBe("chrome")
    expect(classifyExecPath(BRAVE_BIN)).toBe("brave")
  })

  test("classifies helper processes to their parent bundle", () => {
    expect(classifyExecPath(CHROME_HELPER)).toBe("chrome")
    expect(isHelperExecutable(CHROME_HELPER)).toBe(true)
    expect(isHelperExecutable(CHROME_BIN)).toBe(false)
  })

  test("classifies a relocated binary by basename", () => {
    expect(classifyExecPath("/Users/j/Applications/Helium")).toBe("helium")
  })

  test("returns null for unknown or empty paths", () => {
    expect(classifyExecPath("")).toBeNull()
    expect(classifyExecPath("   ")).toBeNull()
    expect(classifyExecPath("/Applications/Firefox.app/Contents/MacOS/firefox")).toBeNull()
    expect(classifyExecPath("/usr/local/bin/interceptor-daemon")).toBeNull()
  })
})

describe("parseLsofFieldOutput", () => {
  const OUTPUT = [
    "p4242",
    "cinterceptor-daemon",
    "fu12",
    "n127.0.0.1:19222->127.0.0.1:54321",
    "p5150",
    "cHelium",
    "fu77",
    "n127.0.0.1:54321->127.0.0.1:19222",
  ].join("\n")

  test("returns one entry per pid with its command", () => {
    expect(parseLsofFieldOutput(OUTPUT)).toEqual([
      { pid: 4242, command: "interceptor-daemon" },
      { pid: 5150, command: "Helium" },
    ])
  })

  test("deduplicates a pid that opens several sockets", () => {
    const repeated = ["p5150", "cHelium", "fu1", "n:1", "p5150", "cHelium", "fu2", "n:2"].join("\n")
    expect(parseLsofFieldOutput(repeated)).toEqual([{ pid: 5150, command: "Helium" }])
  })

  test("empty output yields no peers", () => {
    expect(parseLsofFieldOutput("")).toEqual([])
    expect(parseLsofFieldOutput("\n\n")).toEqual([])
  })
})

describe("pickBrowserPeer", () => {
  const peers = [
    { pid: 4242, command: "interceptor-daemon" },
    { pid: 5150, command: HELIUM_BIN },
  ]

  test("excludes the daemon by pid and returns the browser", () => {
    expect(pickBrowserPeer(peers, [4242])).toEqual({ pid: 5150, command: HELIUM_BIN })
  })

  test("prefers a peer that classifies to a known browser over an unknown one", () => {
    const mixed = [
      { pid: 900, command: "/usr/bin/some-proxy" },
      { pid: 5150, command: CHROME_BIN },
    ]
    expect(pickBrowserPeer(mixed, [4242])?.pid).toBe(5150)
  })

  test("still reports an unknown peer rather than dropping the binding", () => {
    const unknown = [{ pid: 900, command: "/opt/weird/browser" }]
    expect(pickBrowserPeer(unknown, [4242])?.pid).toBe(900)
  })

  test("returns null when every peer is excluded", () => {
    expect(pickBrowserPeer(peers, [4242, 5150])).toBeNull()
    expect(pickBrowserPeer([], [])).toBeNull()
  })
})

describe("describeBinding", () => {
  test("names the binary for a direct binding", () => {
    const line = describeBinding({ pid: 5150, execPath: HELIUM_BIN, binPath: null, id: "helium", label: "Helium" })
    expect(line).toContain("Helium")
    expect(line).toContain(HELIUM_BIN)
    expect(line).toContain("pid 5150")
  })

  test("names the MAIN binary when the socket is held by a helper process", () => {
    const line = describeBinding({
      pid: 5151, execPath: CHROME_HELPER, binPath: CHROME_BIN, id: "chrome", label: "Google Chrome",
    })
    expect(line).toContain(CHROME_BIN)
    expect(line).toContain("via helper")
  })

  test("says so plainly when nothing is bound", () => {
    expect(describeBinding(null)).toContain("not bound")
  })
})

describe("preferredBrowser", () => {
  test("prefers helium, then brave, then chrome", () => {
    expect(BROWSER_PREFERENCE).toEqual(["helium", "brave", "chrome"])
    expect(preferredBrowser(["chrome", "brave", "helium"])).toBe("helium")
    expect(preferredBrowser(["chrome", "brave"])).toBe("brave")
    expect(preferredBrowser(["chrome"])).toBe("chrome")
    expect(preferredBrowser([])).toBeNull()
  })

  test("an explicit override wins over the order", () => {
    expect(preferredBrowser(["helium", "chrome"], "chrome")).toBe("chrome")
  })

  test("a junk override is ignored rather than obeyed", () => {
    expect(preferredBrowser(["helium", "chrome"], "netscape")).toBe("helium")
    expect(preferredBrowser(["helium", "chrome"], "")).toBe("helium")
  })
})

describe("browserPolicyVerdict", () => {
  test("FAILS when Chrome is bound while Helium is installed — the #1377 state", () => {
    const v = browserPolicyVerdict({ bound: "chrome", installed: ["chrome", "helium"] })
    expect(v.ok).toBe(false)
    expect(v.preferred).toBe("helium")
    expect(v.detail).toContain("Google Chrome")
    expect(v.detail).toContain("install.sh --helium")
  })

  test("passes when Chrome is bound and Chrome is all that is installed", () => {
    const v = browserPolicyVerdict({ bound: "chrome", installed: ["chrome"] })
    expect(v.ok).toBe(true)
    expect(v.preferred).toBe("chrome")
  })

  test("passes when the preferred browser is bound", () => {
    expect(browserPolicyVerdict({ bound: "helium", installed: ["chrome", "helium"] }).ok).toBe(true)
  })

  test("an explicit override sanctions Chrome on a Helium machine", () => {
    const v = browserPolicyVerdict({ bound: "chrome", installed: ["chrome", "helium"], override: "chrome" })
    expect(v.ok).toBe(true)
    expect(v.preferred).toBe("chrome")
  })

  test("an override naming a browser that is NOT bound still fails", () => {
    const v = browserPolicyVerdict({ bound: "chrome", installed: ["chrome", "helium"], override: "helium" })
    expect(v.ok).toBe(false)
    expect(v.detail).toContain("INTERCEPTOR_PREFERRED_BROWSER=helium")
  })

  test("nothing bound is not a policy violation", () => {
    const v = browserPolicyVerdict({ bound: null, installed: ["chrome", "helium"] })
    expect(v.ok).toBe(true)
    expect(v.detail).toContain("no browser is currently bound")
  })
})

describe("installedManifestBrowsers", () => {
  test("detects Helium, which the old hand-listed chrome/brave pair could not", () => {
    const home = "/Users/j"
    const heliumManifest = nativeMessagingManifestPath("helium", home)
    expect(heliumManifest).toContain("net.imput.helium/NativeMessagingHosts")
    expect(installedManifestBrowsers(home, p => p === heliumManifest)).toEqual(["helium"])
  })

  test("returns every browser holding a manifest, in registry order", () => {
    const home = "/Users/j"
    const present = new Set([
      nativeMessagingManifestPath("helium", home),
      nativeMessagingManifestPath("chrome", home),
    ])
    expect(installedManifestBrowsers(home, p => present.has(p))).toEqual(["helium", "chrome"])
  })

  test("returns nothing when no manifest is installed", () => {
    expect(installedManifestBrowsers("/Users/j", () => false)).toEqual([])
  })
})
