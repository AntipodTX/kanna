/** Recognize chat routes before absolute paths are treated as workspace files. */
export function parseChatLink(href: string | undefined, origin?: string): string | null {
  if (!href) return null
  let path = href
  if (/^https?:\/\//i.test(href)) {
    if (!origin) return null
    try {
      const url = new URL(href)
      if (url.origin !== new URL(origin).origin) return null
      path = `${url.pathname}${url.search}${url.hash}`
    } catch {
      return null
    }
  }
  return /^\/chat\/[a-zA-Z0-9_-]+\/?(?:[?#].*)?$/.test(path) ? path : null
}
