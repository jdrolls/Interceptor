#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_PATH="$ROOT/daemon/interceptor-daemon"
TEMPLATE_PATH="$ROOT/daemon/com.interceptor.host.json"
GENERATED_DIR="$ROOT/daemon/.generated"
GENERATED_MANIFEST="$GENERATED_DIR/com.interceptor.host.json"
EXTENSION_DIR="$ROOT/extension/dist"
INSTALL_BRIDGE_SCRIPT="$ROOT/scripts/install-bridge.sh"

# ── Parse flags ────────────────────────────────────────────────────────────────
SKIP_EXTENSION=0
BROWSER=""
PROFILE=""
LIST_PROFILES=0
MODE=""           # "" | "browser-only" | "full"
DRY_RUN="${INSTALL_DRY_RUN:-0}"
i=1
while [[ $i -le $# ]]; do
  arg="${!i}"
  case "$arg" in
    --skip-extension) SKIP_EXTENSION=1 ;;
    --brave)  BROWSER="brave" ;;
    --chrome) BROWSER="chrome" ;;
    --helium) BROWSER="helium" ;;
    --profile)
      i=$((i + 1))
      PROFILE="${!i}"
      ;;
    --profile=*) PROFILE="${arg#--profile=}" ;;
    --profiles) LIST_PROFILES=1 ;;
    --browser-only)
      if [[ "$MODE" == "full" ]]; then
        echo "ERROR: --browser-only and --full are mutually exclusive." >&2
        exit 1
      fi
      MODE="browser-only" ;;
    --full)
      if [[ "$MODE" == "browser-only" ]]; then
        echo "ERROR: --browser-only and --full are mutually exclusive." >&2
        exit 1
      fi
      MODE="full" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Unknown flag: $arg" >&2
       echo ""
       echo "Usage: bash scripts/install.sh [MODE] [BROWSER] [OPTIONS]"
       echo ""
       echo "Modes (mutually exclusive; if omitted, you'll be prompted):"
       echo "  --browser-only    Install CLI + daemon + extension only. No macOS bridge."
       echo "                    Smallest footprint, no TCC prompts."
       echo "  --full            Browser-only AND macOS bridge (LaunchAgent + AX +"
       echo "                    ScreenCaptureKit + Apple Events). macOS only."
       echo ""
       echo "Browser (preference order: helium > brave > chrome):"
       echo "  --helium          Target Helium (preferred — honours --load-extension)"
       echo "  --brave           Target Brave Browser"
       echo "  --chrome          Target Google Chrome (branded builds ignore --load-extension)"
       echo "  --profile <name>  Profile directory name (e.g. \"Default\", \"Profile 2\")"
       echo "  --profiles        List available profiles and exit"
       echo ""
       echo "Options:"
       echo "  --skip-extension  Only install native messaging (skip extension load)"
       echo "  --dry-run         Print steps without executing them"
       exit 1 ;;
  esac
  i=$((i + 1))
done

# ── List profiles ──────────────────────────────────────────────────────────────
if [[ "$LIST_PROFILES" == "1" ]]; then
  if [[ -z "$BROWSER" ]]; then
    if [[ -d "/Applications/Helium.app" ]]; then BROWSER="helium"
    elif [[ -d "/Applications/Brave Browser.app" ]]; then BROWSER="brave"
    elif [[ -d "/Applications/Google Chrome.app" ]]; then BROWSER="chrome"
    fi
  fi
  case "$BROWSER" in
    helium) PROFILE_ROOT="$HOME/Library/Application Support/net.imput.helium" ;;
    brave)  PROFILE_ROOT="$HOME/Library/Application Support/BraveSoftware/Brave-Browser" ;;
    chrome) PROFILE_ROOT="$HOME/Library/Application Support/Google/Chrome" ;;
    *) echo "No supported browser found."; exit 1 ;;
  esac

  echo "Available profiles:"
  echo ""
  printf "  %-20s %s\n" "DIRECTORY" "DISPLAY NAME"
  printf "  %-20s %s\n" "---------" "------------"
  for dir in "$PROFILE_ROOT"/*/; do
    name=$(basename "$dir")
    if [[ -f "$dir/Preferences" ]]; then
      display=$(plutil -extract profile.name raw -o - "$dir/Preferences" 2>/dev/null || echo "(unknown)")
      printf "  %-20s %s\n" "$name" "$display"
    fi
  done
  echo ""
  echo "Usage: bash scripts/install.sh --helium --profile \"Profile 2\""
  exit 0
fi

# ── Mode resolution ────────────────────────────────────────────────────────────
# If neither --browser-only nor --full was passed, prompt interactively.
# Default: macOS → "full", anything else → "browser-only" (full mode is mac-only).
if [[ -z "$MODE" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    DEFAULT_MODE="full"
  else
    DEFAULT_MODE="browser-only"
  fi

  # In dry-run / non-interactive contexts, fall back to the platform default
  # rather than blocking on stdin.
  if [[ "$DRY_RUN" == "1" || ! -t 0 ]]; then
    MODE="$DEFAULT_MODE"
    echo "==> Mode not specified; defaulting to '$MODE' (non-interactive)."
  else
    echo "Choose install mode:"
    echo "  browser-only  CLI + daemon + extension. No macOS bridge."
    echo "                No TCC prompts (Screen Recording, Accessibility, etc.)."
    echo "  full          Browser-only PLUS the macOS Swift bridge."
    echo "                Adds 'interceptor macos *' commands; macOS will prompt"
    echo "                for Screen Recording / Accessibility / Apple Events on"
    echo "                first use."
    echo ""
    read -r -p "Mode [browser-only/full] (default: $DEFAULT_MODE): " ANSWER
    ANSWER="${ANSWER:-$DEFAULT_MODE}"
    case "$ANSWER" in
      browser-only|full) MODE="$ANSWER" ;;
      *)
        echo "Unrecognized mode '$ANSWER'. Use --browser-only or --full." >&2
        exit 1 ;;
    esac
  fi
fi

if [[ "$MODE" == "full" && "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: --full mode is macOS only (the Swift bridge is mac-only)." >&2
  echo "       Use --browser-only on this platform." >&2
  exit 1
fi

echo "==> Mode: $MODE"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "==> DRY RUN — no files will be created or modified."
fi

# ── Browser resolution ────────────────────────────────────────────────────────
# If no browser flag was passed, resolve by PREFERENCE ORDER over what is
# actually installed: helium > brave > chrome. Valid resolved values:
#   "helium" | "chrome" | "brave" | "both"
#
# The old rule was "default to chrome", which is how a machine running Helium
# ended up with its manifest in Chrome and every verification run launching a
# Chrome nobody wanted (dora-cc#1377). Chrome is last on purpose: branded Chrome
# desktop builds ignore --load-extension (see the notice load_extension prints),
# so the unpacked extension has to be re-loaded by hand there. This order is the
# same one `shared/browsers.ts` enforces in `interceptor doctor`.
if [[ -z "$BROWSER" ]]; then
  HELIUM_INSTALLED=0
  CHROME_INSTALLED=0
  BRAVE_INSTALLED=0
  [[ -d "/Applications/Helium.app" ]] && HELIUM_INSTALLED=1
  [[ -d "/Applications/Google Chrome.app" ]] && CHROME_INSTALLED=1
  [[ -d "/Applications/Brave Browser.app" ]] && BRAVE_INSTALLED=1
  INSTALLED_COUNT=$(( HELIUM_INSTALLED + CHROME_INSTALLED + BRAVE_INSTALLED ))

  # Most-preferred installed browser.
  PREFERRED=""
  if   (( HELIUM_INSTALLED )); then PREFERRED="helium"
  elif (( BRAVE_INSTALLED ));  then PREFERRED="brave"
  elif (( CHROME_INSTALLED )); then PREFERRED="chrome"
  fi

  if (( INSTALLED_COUNT == 0 )); then
    echo "ERROR: No supported browser found in /Applications/." >&2
    echo "       Install Helium, Brave Browser, or Google Chrome, then re-run." >&2
    exit 1
  fi

  if (( INSTALLED_COUNT == 1 )); then
    BROWSER="$PREFERRED"
    echo "==> Browser: $BROWSER (only supported browser found)"
  elif [[ "$DRY_RUN" == "1" || ! -t 0 ]]; then
    BROWSER="$PREFERRED"
    echo "==> Browser not specified; choosing '$BROWSER' by preference order (non-interactive)."
  else
    echo ""
    echo "Choose target browser (preference order: helium > brave > chrome):"
    (( HELIUM_INSTALLED )) && echo "  helium   Helium (preferred)"
    (( CHROME_INSTALLED )) && echo "  chrome   Google Chrome"
    (( BRAVE_INSTALLED ))  && echo "  brave    Brave Browser"
    echo "  both     Install for Chrome and Brave"
    echo ""
    read -r -p "Browser [helium/chrome/brave/both] (default: $PREFERRED): " ANSWER
    ANSWER="${ANSWER:-$PREFERRED}"
    case "$ANSWER" in
      helium|chrome|brave|both) BROWSER="$ANSWER" ;;
      *)
        echo "Unrecognized browser '$ANSWER'. Use helium, chrome, brave, or both." >&2
        exit 1 ;;
    esac
  fi
fi

echo "==> Browser: $BROWSER"

# Helper that runs a step or prints it under --dry-run.
run_step() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY: $*"
  else
    eval "$@"
  fi
}

# ── Step 1: Generate native messaging manifest ────────────────────────────────
echo "==> [browser] Generating native messaging manifest..."
if [[ "$DRY_RUN" == "1" ]]; then
  echo "    DRY: mkdir -p $GENERATED_DIR"
  echo "    DRY: sed __DAEMON_PATH__ -> $DAEMON_PATH > $GENERATED_MANIFEST"
else
  mkdir -p "$GENERATED_DIR"
  ESCAPED_DAEMON_PATH="$(printf '%s' "$DAEMON_PATH" | sed 's/[&|\\]/\\&/g')"
  sed "s|__DAEMON_PATH__|$ESCAPED_DAEMON_PATH|g" "$TEMPLATE_PATH" > "$GENERATED_MANIFEST"
fi

# ── Step 2: Install native messaging symlinks for chosen browser(s) ───────────
echo "==> [browser] Installing native messaging symlink(s)..."
NM_DIRS=()
case "$BROWSER" in
  helium) NM_DIRS+=("$HOME/Library/Application Support/net.imput.helium/NativeMessagingHosts") ;;
  chrome) NM_DIRS+=("$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts") ;;
  brave)  NM_DIRS+=("$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts") ;;
  both)
    NM_DIRS+=("$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts")
    NM_DIRS+=("$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts")
    ;;
esac

for dir in "${NM_DIRS[@]}"; do
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "    DRY: mkdir -p $dir"
    echo "    DRY: ln -sfn $GENERATED_MANIFEST $dir/com.interceptor.host.json"
  else
    mkdir -p "$dir"
    ln -sfn "$GENERATED_MANIFEST" "$dir/com.interceptor.host.json"
    case "$dir" in
      *net.imput.helium*) echo "    Helium: $dir/com.interceptor.host.json" ;;
      *Google/Chrome*)    echo "    Chrome: $dir/com.interceptor.host.json" ;;
      *Brave-Browser*)    echo "    Brave:  $dir/com.interceptor.host.json" ;;
    esac
  fi
done

# ── Step 3: Load extension into browser via --load-extension ──────────────────
# Takes one arg: "chrome" | "brave". Reads $SKIP_EXTENSION, $PROFILE, $DRY_RUN,
# $EXTENSION_DIR from the surrounding scope.
load_extension() {
  local target="$1"

  if [[ "$SKIP_EXTENSION" == "1" ]]; then
    echo ""
    echo "==> [browser] Skipping extension loading (--skip-extension)"
    return 0
  fi

  if [[ ! -d "$EXTENSION_DIR" && "$DRY_RUN" != "1" ]]; then
    echo ""
    echo "==> Extension not built yet. Run: bash scripts/build.sh"
    echo "    Then re-run this script."
    exit 1
  fi

  local BROWSER_APP BROWSER_BIN BROWSER_NAME
  case "$target" in
    helium)
      BROWSER_APP="/Applications/Helium.app"
      BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Helium"
      BROWSER_NAME="Helium"
      ;;
    brave)
      BROWSER_APP="/Applications/Brave Browser.app"
      BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Brave Browser"
      BROWSER_NAME="Brave"
      ;;
    chrome)
      BROWSER_APP="/Applications/Google Chrome.app"
      BROWSER_BIN="$BROWSER_APP/Contents/MacOS/Google Chrome"
      BROWSER_NAME="Chrome"
      ;;
    *)
      echo "ERROR: load_extension called with unknown browser '$target'." >&2
      return 1 ;;
  esac

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "==> [browser] DRY: would launch $BROWSER_NAME --load-extension=$EXTENSION_DIR"
    return 0
  fi

  # Check if browser is already running
  local BROWSER_RUNNING=0
  if pgrep -f "$BROWSER_BIN" >/dev/null 2>&1; then
    BROWSER_RUNNING=1
  fi

  if [[ "$BROWSER_RUNNING" == "1" ]]; then
    echo ""
    echo "==> $BROWSER_NAME is already running."
    echo "    To load the extension without browser intervention, $BROWSER_NAME must be restarted."
    echo ""
    echo "    Option 1 — Quit $BROWSER_NAME, then re-run this script."
    echo ""
    echo "    Option 2 — Load manually:"
    echo "      1. Open chrome://extensions"
    echo "      2. Enable Developer Mode"
    echo "      3. Load unpacked → $EXTENSION_DIR"
    echo ""
    echo "    Option 3 — Force restart (will restore tabs on relaunch):"
    read -p "      Quit $BROWSER_NAME and relaunch with extension? [y/N] " CONFIRM
    if [[ "${CONFIRM:-n}" == "y" || "${CONFIRM:-n}" == "Y" ]]; then
      echo "    Quitting $BROWSER_NAME..."
      osascript -e "tell application \"$BROWSER_NAME Browser\" to quit" 2>/dev/null || \
      osascript -e "tell application \"$BROWSER_NAME\" to quit" 2>/dev/null || true
      sleep 2
      for j in {1..10}; do
        if ! pgrep -f "$BROWSER_BIN" >/dev/null 2>&1; then break; fi
        sleep 1
      done
    else
      echo "    Skipping extension loading."
      return 0
    fi
  fi

  if [[ "$target" == "chrome" ]]; then
    echo ""
    echo "==> Google Chrome ignores --load-extension in branded desktop builds."
    echo "    Use one of these paths instead:"
    echo "      1. Developer flow: open chrome://extensions, enable Developer Mode,"
    echo "         then Load unpacked -> $EXTENSION_DIR"
    echo ""
    echo "    Native messaging metadata has already been installed."
    return 0
  fi

  echo ""
  echo "==> [browser] Launching $BROWSER_NAME with --load-extension..."
  echo "    Extension: $EXTENSION_DIR"

  # Build launch args
  local LAUNCH_ARGS=(--load-extension="$EXTENSION_DIR")
  if [[ -n "$PROFILE" ]]; then
    LAUNCH_ARGS+=(--profile-directory="$PROFILE")
    echo "    Profile:   $PROFILE"
  fi

  open -a "$BROWSER_APP" --args "${LAUNCH_ARGS[@]}"

  echo ""
  echo "==> Extension loaded into $BROWSER_NAME."
  echo "    Extension ID: hkjbaciefhhgekldhncknbjkofbpenng"
  if [[ -n "$PROFILE" ]]; then
    echo "    Profile: $PROFILE"
  fi
}

case "$BROWSER" in
  helium|chrome|brave) load_extension "$BROWSER" ;;
  both)
    load_extension chrome
    load_extension brave
    ;;
esac

# ── Step 4 (full mode only): Install Swift bridge ──────────────────────────────
# browser-only MUST NOT touch the LaunchAgent or .app bundle.
if [[ "$MODE" == "browser-only" ]]; then
  echo ""
  echo "==> Done. Installed in browser-only mode."
  echo "    No macOS bridge installed; no LaunchAgent written."
  echo "    Test:    interceptor status   (expect 'mode: browser-only')"
  echo ""
  echo "    To upgrade later:    interceptor upgrade --full"
  exit 0
fi

# MODE == "full" past this point.
echo ""
echo "==> [bridge] Chaining into install-bridge.sh..."
if [[ "$DRY_RUN" == "1" ]]; then
  echo "    DRY: bash $INSTALL_BRIDGE_SCRIPT"
  echo "    DRY: would write ~/Library/LaunchAgents/com.interceptor.bridge.plist"
  echo "    DRY: would lsregister ~/.local/share/interceptor/interceptor-bridge.app"
  echo "    DRY: would launchctl bootstrap gui/$(id -u 2>/dev/null || echo "<uid>")"
  echo ""
  echo "==> DRY-RUN complete (full mode)."
  exit 0
fi

if [[ ! -x "$INSTALL_BRIDGE_SCRIPT" && ! -f "$INSTALL_BRIDGE_SCRIPT" ]]; then
  echo "ERROR: $INSTALL_BRIDGE_SCRIPT not found." >&2
  echo "       Build the bridge first: bash scripts/build-bridge.sh" >&2
  exit 1
fi

bash "$INSTALL_BRIDGE_SCRIPT"

echo ""
echo "==> Done. Installed in full computer-use mode."
echo "    Test:    interceptor status   (expect 'mode: full')"
echo "    First 'interceptor macos screenshot' will prompt for Screen Recording."
echo "    First 'interceptor macos act' will prompt for Accessibility."
echo "    First 'interceptor macos intent dispatch' will prompt for Apple Events."
