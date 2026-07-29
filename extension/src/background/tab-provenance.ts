import type { ActionResult } from "./router"
import type { TabResolvedVia } from "../../../shared/tab-provenance"

export type { TabResolvedVia } from "../../../shared/tab-provenance"

type ActiveTabResolvedVia = Exclude<TabResolvedVia, "explicit" | "stored">

export type TabFallbackResolution =
  | { success: true; tabId: number; tabResolvedVia: ActiveTabResolvedVia }
  | { success: false; tabId?: number; tabResolvedVia?: Extract<ActiveTabResolvedVia, "active-drift">; error: string }

/**
 * Resolve the active-tab fallback after the caller has checked session storage.
 * A stale stored id is dangerous because selecting the browser's current tab
 * would silently retarget the command; cold starts remain intentionally permissive.
 */
export function resolveTabFallback(opts: {
  activeTab?: { id?: number; url?: string }
  staleStoredTabId?: number
  allowTabDrift?: boolean
}): TabFallbackResolution {
  const tabId = opts.activeTab?.id
  if (tabId === undefined) return { success: false, error: "no active tab" }

  if (opts.staleStoredTabId === undefined) {
    return { success: true, tabId, tabResolvedVia: "active-cold" }
  }

  if (opts.allowTabDrift) {
    return { success: true, tabId, tabResolvedVia: "active-drift" }
  }

  return {
    success: false,
    tabId,
    tabResolvedVia: "active-drift",
    error: `stored tab ${opts.staleStoredTabId} is gone; refusing to silently run on tab ${tabId} (${opts.activeTab?.url || "unknown URL"}) — pass --tab explicitly, run 'interceptor open <url>', or set INTERCEPTOR_ALLOW_TAB_DRIFT=1`
  }
}

export async function applyTabProvenance(
  result: ActionResult,
  tabResolvedVia: TabResolvedVia | undefined,
  getResolvedTabUrl: () => Promise<string | undefined>
): Promise<ActionResult> {
  if (tabResolvedVia !== "stored" && tabResolvedVia !== "active-cold" && tabResolvedVia !== "active-drift") return result

  const provenance: Pick<ActionResult, "tabResolvedVia" | "resolvedTabUrl"> = { tabResolvedVia }
  try {
    const resolvedTabUrl = await getResolvedTabUrl()
    if (resolvedTabUrl !== undefined) provenance.resolvedTabUrl = resolvedTabUrl
  } catch {}

  return { ...result, ...provenance }
}
