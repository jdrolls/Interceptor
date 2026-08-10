/**
 * shared/browsers.ts — the canonical registry of browsers Interceptor installs
 * into, and the preference order that decides which one it *should* be bound to.
 *
 * Before this file the browser list lived in three places that disagreed:
 * `scripts/install.sh` (chrome | brave, defaulting to chrome non-interactively),
 * `cli/lib/status-renderer.ts` (`detectConfiguredBrowsers`, chrome | brave), and
 * nothing at all knew about Helium — so a machine running Helium silently got
 * the native-messaging manifest written into Chrome, and every verification run
 * launched and pinned a Chrome instance nobody wanted (dora-cc#1377).
 *
 * Preference order is Helium-first. The reason is mechanical, not aesthetic:
 * branded Google Chrome desktop builds ignore `--load-extension` (see the
 * warning `scripts/install.sh` prints for the chrome target), so an unpacked
 * Interceptor extension has to be re-loaded by hand through the developer-mode
 * UI after every profile reset. Chromium forks — Helium and Brave — honour the
 * flag, which is what makes an unattended install reproducible. Helium leads
 * Brave because it is the lightweight profile this system already dedicates to
 * agent browsing.
 *
 * Everything here is pure data + pure functions so both the CLI and the tests
 * can use it without a browser, a Mac, or a filesystem.
 */

export type BrowserId = "helium" | "brave" | "chrome"

export type BrowserSpec = {
  id: BrowserId
  /** Human label used in status/doctor output. */
  label: string
  /** macOS application bundle. */
  appPath: string
  /** The main browser executable inside the bundle — what `ps -o comm=` reports. */
  binPath: string
  /** Per-user support directory, relative to $HOME. */
  supportDir: string
  bundleId: string
  /**
   * Whether the branded desktop build honours `--load-extension`. False for
   * Chrome, which forces the manual developer-mode load.
   */
  acceptsLoadExtension: boolean
}

export const BROWSERS: readonly BrowserSpec[] = [
  {
    id: "helium",
    label: "Helium",
    appPath: "/Applications/Helium.app",
    binPath: "/Applications/Helium.app/Contents/MacOS/Helium",
    supportDir: "Library/Application Support/net.imput.helium",
    bundleId: "net.imput.helium",
    acceptsLoadExtension: true,
  },
  {
    id: "brave",
    label: "Brave Browser",
    appPath: "/Applications/Brave Browser.app",
    binPath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    supportDir: "Library/Application Support/BraveSoftware/Brave-Browser",
    bundleId: "com.brave.Browser",
    acceptsLoadExtension: true,
  },
  {
    id: "chrome",
    label: "Google Chrome",
    appPath: "/Applications/Google Chrome.app",
    binPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    supportDir: "Library/Application Support/Google/Chrome",
    bundleId: "com.google.Chrome",
    acceptsLoadExtension: false,
  },
]

/** Most-preferred first. `interceptor doctor` enforces this order. */
export const BROWSER_PREFERENCE: readonly BrowserId[] = ["helium", "brave", "chrome"]

/** Env var that lets an operator sanction a less-preferred browser explicitly. */
export const PREFERRED_BROWSER_ENV = "INTERCEPTOR_PREFERRED_BROWSER"

export function browserSpec(id: BrowserId): BrowserSpec {
  const spec = BROWSERS.find(b => b.id === id)
  if (!spec) throw new Error(`unknown browser id '${id}'`)
  return spec
}

export function isBrowserId(value: unknown): value is BrowserId {
  return typeof value === "string" && BROWSERS.some(b => b.id === value)
}

/** Where a browser looks for the `com.interceptor.host.json` manifest. */
export function nativeMessagingDir(id: BrowserId, home: string): string {
  return `${home}/${browserSpec(id).supportDir}/NativeMessagingHosts`
}

export function nativeMessagingManifestPath(id: BrowserId, home: string): string {
  return `${nativeMessagingDir(id, home)}/com.interceptor.host.json`
}

/**
 * True when the path belongs to one of Chromium's out-of-process children
 * (`... Helper (Renderer)`, `... Helper (GPU)`, crashpad). Those share the
 * parent bundle, so they classify to the right browser — but the *binary* we
 * report should be the main executable, not the helper.
 */
export function isHelperExecutable(execPath: string): boolean {
  return /Helper( \([^)]*\))?$/.test(execPath) || execPath.includes("crashpad")
}

/**
 * Map an executable path to a known browser. Bundle-path match first (survives
 * helper processes and non-default install locations under a different parent
 * directory), basename match as the fallback for oddly-relocated binaries.
 *
 * Order matters: "/Google Chrome.app/" must be tested against the bundle path,
 * not a bare "Chrome" substring, or `Google Chrome Helper` under a *Helium*
 * bundle (impossible today, but the substring approach is what makes it a
 * future landmine) would misclassify.
 */
export function classifyExecPath(execPath: string): BrowserId | null {
  const path = execPath.trim()
  if (!path) return null
  for (const spec of BROWSERS) {
    const bundle = spec.appPath.slice(spec.appPath.lastIndexOf("/") + 1) // "Helium.app"
    if (path.includes(`/${bundle}/`) || path.endsWith(`/${bundle}`)) return spec.id
  }
  const base = path.slice(path.lastIndexOf("/") + 1)
  for (const spec of BROWSERS) {
    const specBase = spec.binPath.slice(spec.binPath.lastIndexOf("/") + 1)
    if (base === specBase) return spec.id
  }
  return null
}

/**
 * The browser Interceptor *should* be bound to, given what is installed.
 * An explicit override wins whenever it names a real browser id — that is the
 * documented escape hatch for "Chrome is sanctioned on this machine".
 */
export function preferredBrowser(
  installed: readonly BrowserId[],
  override?: string | null
): BrowserId | null {
  if (isBrowserId(override)) return override
  for (const id of BROWSER_PREFERENCE) {
    if (installed.includes(id)) return id
  }
  return null
}

export type BrowserPolicyVerdict = {
  ok: boolean
  /** null when there is nothing to compare against (nothing bound / nothing installed). */
  preferred: BrowserId | null
  detail: string
}

/**
 * The Helium-first policy check `interceptor doctor` runs.
 *
 * It fails ONLY when a more-preferred browser is actually installed and a
 * less-preferred one is bound. A machine with nothing but Chrome is compliant —
 * the policy is "use the best browser present", not "install Helium".
 */
export function browserPolicyVerdict(opts: {
  bound: BrowserId | null
  installed: readonly BrowserId[]
  override?: string | null
}): BrowserPolicyVerdict {
  const { bound, installed, override } = opts
  const preferred = preferredBrowser(installed, override)

  if (bound === null) {
    return { ok: true, preferred, detail: "no browser is currently bound to the daemon" }
  }
  if (preferred === null) {
    return { ok: true, preferred, detail: `bound to ${browserSpec(bound).label}; no preference could be resolved` }
  }
  if (bound === preferred) {
    return { ok: true, preferred, detail: `bound to ${browserSpec(bound).label} (preferred)` }
  }
  if (isBrowserId(override)) {
    return {
      ok: false,
      preferred,
      detail:
        `bound to ${browserSpec(bound).label} but ${PREFERRED_BROWSER_ENV}=${override} ` +
        `asks for ${browserSpec(preferred).label} — reinstall native messaging: ` +
        `bash scripts/install.sh --${preferred}`,
    }
  }
  return {
    ok: false,
    preferred,
    detail:
      `bound to ${browserSpec(bound).label} but ${browserSpec(preferred).label} is installed ` +
      `and preferred — reinstall native messaging with 'bash scripts/install.sh --${preferred}', ` +
      `or set ${PREFERRED_BROWSER_ENV}=${bound} to sanction ${browserSpec(bound).label} on this machine`,
  }
}
