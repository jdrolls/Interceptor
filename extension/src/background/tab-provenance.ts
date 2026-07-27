import type { ActionResult } from "./router"

export type TabResolvedVia = "explicit" | "stored" | "active-drift"

export async function applyTabProvenance(
  result: ActionResult,
  tabResolvedVia: TabResolvedVia | undefined,
  getResolvedTabUrl: () => Promise<string | undefined>
): Promise<ActionResult> {
  if (tabResolvedVia !== "stored" && tabResolvedVia !== "active-drift") return result

  const provenance: Pick<ActionResult, "tabResolvedVia" | "resolvedTabUrl"> = { tabResolvedVia }
  try {
    const resolvedTabUrl = await getResolvedTabUrl()
    if (resolvedTabUrl !== undefined) provenance.resolvedTabUrl = resolvedTabUrl
  } catch {}

  return { ...result, ...provenance }
}
