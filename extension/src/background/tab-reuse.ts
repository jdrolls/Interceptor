export type ReusableTab = { id?: number; url?: string; groupId?: number }

export function normalizeUrlForReuse(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (!parsed.protocol || !parsed.hostname) return undefined
    const pathname = parsed.pathname.endsWith("/")
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`
  } catch {
    return undefined
  }
}

export function findReusableTab(tabs: ReusableTab[], url: string, groupId: number | null): number | undefined {
  if (groupId === null || groupId === -1) return undefined
  const target = normalizeUrlForReuse(url)
  if (!target) return undefined

  let match: number | undefined
  for (const tab of tabs) {
    if (tab.groupId === groupId && tab.id !== undefined && normalizeUrlForReuse(tab.url) === target) {
      match = tab.id
    }
  }
  return match
}
