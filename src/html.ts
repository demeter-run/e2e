/**
 * Reading a server-rendered page as text. website2's SSR HTML carries NUL bytes
 * in TanStack match ids, so a tool that sniffs binary sees nothing in it; the
 * page is read here as a string, with no DOM and no browser.
 */

const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity
    }
    return named[body.toLowerCase()] ?? entity
  })
}

const squash = (text: string): string => decodeEntities(text).replace(/\s+/g, ' ').trim()

/** The page without NULs, scripts, styles and comments. */
function strip(html: string): string {
  return html
    .replaceAll('\0', '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}

/** Every text node on the page, in document order, whitespace collapsed. */
export function textTokens(html: string): string[] {
  return strip(html)
    .split(/<[^>]*>/)
    .map(squash)
    .filter((t) => t !== '')
}

export interface Anchor {
  /** The link target, resolved against the page's URL; as written when it is not a URL. */
  href: string
  /** What a visitor reads on the link. */
  text: string
  /** Set when `href` is not a URL, which a browser cannot follow either. */
  broken?: true
}

/**
 * Every `<a href>` on the page with its visible text. A link whose target is
 * not a URL is kept, marked `broken`: dropped, a broken sign-up CTA would
 * leave the rules nothing to fail on.
 */
export function anchors(html: string, pageUrl: string): Anchor[] {
  const found: Anchor[] = []
  for (const m of strip(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[1]!)
    if (!href) continue
    const written = decodeEntities(href[1] ?? href[2]!)
    const text = squash(m[2]!.replace(/<[^>]*>/g, ' '))
    try {
      found.push({ href: new URL(written, pageUrl).toString(), text })
    } catch {
      found.push({ href: written, text, broken: true })
    }
  }
  return found
}
