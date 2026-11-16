/**
 * @local/free-web-search — a free, key-less `WebSearchProvider` for `ctx.web`.
 *
 * It scrapes the public Bing SERP, preferring the RSS form (`&format=rss`), which is
 * tiny, well-formed XML, and falling back to the HTML SERP for the same query. No API
 * key, account, or paid plan is involved, so the provider's `available()` is always
 * true; failures are network failures, reported as `WEB_PROVIDER_ERROR`.
 *
 * Registered provider id: `free-bing`.
 * @module @local/free-web-search
 */

/** Provider id registered into `ctx.web`. */
export const FREE_SEARCH_PROVIDER_ID = 'free-bing'

/** Browser-like UA: the plain harness UA is served a stripped page by some edges. */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Bing hosts tried in order; the CN edge is first because it is the fastest here. */
const DEFAULT_HOSTS = ['https://cn.bing.com', 'https://www.bing.com']

const DEFAULTS = {
  hosts: DEFAULT_HOSTS,
  timeoutMs: 20000,
  maxResults: 10,
  language: 'zh-CN',
  userAgent: DEFAULT_USER_AGENT,
}

/**
 * Resolve the `WebError` class from the web seam when it is reachable, so thrown errors
 * carry the seam's routable `code`. Falls back to `Error` when the peer package cannot be
 * resolved from this plugin's install location.
 */
let WebErrorClass
async function webError(message, code) {
  if (WebErrorClass === undefined) {
    try {
      WebErrorClass = (await import('@deepseek-ai/dsh-web')).WebError
    } catch {
      WebErrorClass = null
    }
  }
  if (WebErrorClass) return new WebErrorClass(message, code)
  const error = new Error(message)
  error.code = code
  return error
}

/** Decode the five XML/HTML entities that matter for titles and snippets. */
function decodeEntities(input) {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

/** Strip tags and collapse whitespace into one readable line. */
function plainText(input) {
  return decodeEntities(input.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Unwrap Bing's `/ck/a?...&u=a1<base64url>` click-tracking links into the real target. */
function unwrapBingLink(href) {
  if (!href) return undefined
  try {
    const url = new URL(href, 'https://www.bing.com')
    if (!url.hostname.endsWith('bing.com') || !url.pathname.startsWith('/ck/a')) return url.toString()
    const token = url.searchParams.get('u')
    if (!token || !token.startsWith('a1')) return url.toString()
    const base64 = token.slice(2).replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(base64, 'base64').toString('utf8')
    return URL.canParse(decoded) ? decoded : url.toString()
  } catch {
    return href
  }
}

/** Parse the RSS form of a Bing SERP. */
function parseRss(xml) {
  const sources = []
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = match[1]
    const url = /<link>([\s\S]*?)<\/link>/.exec(body)?.[1]
    if (!url) continue
    const title = /<title>([\s\S]*?)<\/title>/.exec(body)?.[1]
    const description = /<description>([\s\S]*?)<\/description>/.exec(body)?.[1]
    const published = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(body)?.[1]
    sources.push({
      url: decodeEntities(url.trim()),
      ...title ? { title: plainText(title) } : {},
      ...description ? { snippet: plainText(description) } : {},
      ...published ? { publishedAt: plainText(published) } : {},
    })
  }
  return sources
}

/** Parse the HTML form of a Bing SERP (`li.b_algo` blocks). */
function parseHtml(html) {
  const sources = []
  for (const block of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const body = block[0]
    const heading = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(body)
    if (!heading) continue
    const href = /<a[^>]+href="([^"]+)"/.exec(heading[1])?.[1]
    const url = unwrapBingLink(href)
    if (!url) continue
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(body)?.[1]
    sources.push({
      url,
      ...heading[1] ? { title: plainText(heading[1]) } : {},
      ...snippet ? { snippet: plainText(snippet) } : {},
    })
  }
  return sources
}

/** Drop duplicate URLs, keeping the first occurrence. */
function dedupe(sources) {
  const seen = new Set()
  const unique = []
  for (const source of sources) {
    if (seen.has(source.url)) continue
    seen.add(source.url)
    unique.push(source)
  }
  return unique
}

/** One HTTP GET with a request deadline; returns the decoded body text. */
async function getText(url, { userAgent, language, signal, timeoutMs }) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (signal) signals.push(signal)
  const response = await fetch(url, {
    headers: {
      'user-agent': userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': `${language},${language.split('-')[0]};q=0.9,en;q=0.8`,
    },
    redirect: 'follow',
    signal: AbortSignal.any(signals),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`)
  return await response.text()
}

/** The key-less Bing search provider. */
class FreeBingSearchProvider {
  id = FREE_SEARCH_PROVIDER_ID
  settings

  constructor(settings) {
    this.settings = settings
  }

  /** No credential to check: plain anonymous HTTP is always usable. */
  available() {
    return this.settings.hosts.length > 0
  }

  async search(request, signal) {
    const query = request.query.trim()
    if (query.length === 0) return { sources: [], truncated: false }
    const limit = Math.max(1, Math.min(request.maxResults ?? this.settings.maxResults, 30))
    const failures = []

    for (const host of this.settings.hosts) {
      const encoded = encodeURIComponent(query)
      const language = encodeURIComponent(this.settings.language)
      const attempts = [
        { kind: 'rss', url: `${host}/search?q=${encoded}&format=rss&count=${limit}&setlang=${language}` },
        { kind: 'html', url: `${host}/search?q=${encoded}&count=${limit}&setlang=${language}` },
      ]
      for (const attempt of attempts) {
        try {
          const text = await getText(attempt.url, { ...this.settings, signal })
          const sources = dedupe(attempt.kind === 'rss' ? parseRss(text) : parseHtml(text))
          if (sources.length > 0) {
            return { sources: sources.slice(0, limit), truncated: sources.length > limit }
          }
          failures.push(`${attempt.kind} via ${new URL(host).host}: no parsable results (${text.length} bytes)`)
        } catch (error) {
          failures.push(`${attempt.kind} via ${new URL(host).host}: ${error?.message ?? String(error)}`)
        }
      }
    }

    throw await webError(
      `free web search failed for "${query}" (no API key involved; every public SERP request failed). ` +
        `Attempts: ${failures.join('; ')}`,
      'WEB_PROVIDER_ERROR',
    )
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'free-web-search'

/** The web seam this provider registers into. */
export const inject = ['web']

/**
 * Resolve the effective settings from the loader row's `config`, tolerating absent or
 * partially specified values.
 */
function resolveSettings(config) {
  const hosts = Array.isArray(config?.hosts) && config.hosts.length > 0
    ? config.hosts.filter((host) => typeof host === 'string' && URL.canParse(host))
    : DEFAULTS.hosts
  return {
    hosts: hosts.length > 0 ? hosts : DEFAULTS.hosts,
    timeoutMs: Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULTS.timeoutMs,
    maxResults: Number.isFinite(config?.maxResults) && config.maxResults > 0 ? config.maxResults : DEFAULTS.maxResults,
    language: typeof config?.language === 'string' && config.language.length > 0 ? config.language : DEFAULTS.language,
    userAgent: typeof config?.userAgent === 'string' && config.userAgent.length > 0 ? config.userAgent : DEFAULTS.userAgent,
  }
}

/** Register the free search provider with `ctx.web`. */
export function apply(ctx, config) {
  const provider = new FreeBingSearchProvider(resolveSettings(config))
  ctx.effect(() => ctx.web.registerSearchProvider(provider), 'free-web-search.registerSearchProvider()')
}
