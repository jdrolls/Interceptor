import { describe, expect, test } from "bun:test"
import { findReusableTab, normalizeUrlForReuse } from "../extension/src/background/tab-reuse"

describe("normalizeUrlForReuse", () => {
  test("drops fragments while preserving queries and normalizing host case", () => {
    expect(normalizeUrlForReuse("HTTPS://Example.COM/path/?q=one#section")).toBe("https://example.com/path?q=one")
  })

  test("strips one trailing slash and rejects invalid URLs", () => {
    expect(normalizeUrlForReuse("https://example.com/")).toBe("https://example.com")
    expect(normalizeUrlForReuse(undefined)).toBeUndefined()
    expect(normalizeUrlForReuse("not a url")).toBeUndefined()
  })
})

describe("findReusableTab", () => {
  const url = "https://example.com/page?q=one"

  test("matches a same-URL tab only within the interceptor group", () => {
    expect(findReusableTab([
      { id: 1, url, groupId: 2 },
      { id: 2, url, groupId: 7 }
    ], url, 7)).toBe(2)
  })

  test("never hijacks an identical URL from another group", () => {
    expect(findReusableTab([{ id: 1, url, groupId: 2 }], url, 7)).toBeUndefined()
  })

  test("requires an existing interceptor group", () => {
    expect(findReusableTab([{ id: 1, url, groupId: 7 }], url, null)).toBeUndefined()
    expect(findReusableTab([{ id: 1, url, groupId: 7 }], url, -1)).toBeUndefined()
  })

  test("returns the last matching tab", () => {
    expect(findReusableTab([
      { id: 1, url, groupId: 7 },
      { id: 2, url: `${url}#later`, groupId: 7 }
    ], url, 7)).toBe(2)
  })

  test("returns undefined when no URL matches", () => {
    expect(findReusableTab([{ id: 1, url: "https://example.com/other", groupId: 7 }], url, 7)).toBeUndefined()
  })
})
