# Free Web Search (`@local/free-web-search`)

A **free, key-less** web search backend for this DSH profile. It registers a
`WebSearchProvider` into the `ctx.web` seam under the id `free-bing`, and the bundle patch
pins `web.searchProvider` to it. The existing `web_search` / `web_fetch` tools then work
without any search API key or paid plan.

## Why it exists

The shipped route (`web-search-deepseek`) performs retrieval as an auxiliary DeepSeek
Messages request using `DEEPSEEK_API_KEY`. With an invalid or absent key every
`web_search` call failed with `HTTP 401`, even though the machine had working outbound
network access. This plugin replaces only the **search** half of the seam; `web_fetch`
keeps using the shipped anonymous `http` provider, which already worked.

## How it works

1. `GET https://cn.bing.com/search?q=…&format=rss&count=N&setlang=…` — the RSS form of the
   public SERP: small XML, no JavaScript, parsed into `title` / `url` / `snippet`.
2. If RSS yields no parsable results, the HTML SERP of the same host is parsed
   (`li.b_algo` blocks, including Bing `/ck/a` redirect-link unwrapping).
3. Hosts are tried in order (`cn.bing.com`, then `www.bing.com`); each host is tried as
   RSS then HTML. All attempts failing raises one `WEB_PROVIDER_ERROR` (or a plain
   `Error` carrying `code: 'WEB_PROVIDER_ERROR'` when the seam's error class cannot be
   imported) that names every attempt.

No API key, no account, no browser automation, no proxy. Requests are plain anonymous
HTTP with a browser-like `User-Agent` and a per-request deadline.

## Configuration (`config` on the `free-web-search` row)

| Field | Default | Meaning |
|---|---|---|
| `hosts` | `["https://cn.bing.com", "https://www.bing.com"]` | SERP hosts tried in order |
| `timeoutMs` | `20000` | Per-request deadline |
| `maxResults` | `10` | Upper bound requested from the SERP (the seam still caps at the tool's `searchMaxResults`) |
| `language` | `"zh-CN"` | `setlang` / `Accept-Language` hint |
| `userAgent` | Chrome 124 desktop string | Request `User-Agent` |

Everything is optional; invalid or absent values fall back to the defaults above.

## Install / remove

Installed with `plugin_manager` `install_bundle` against this directory. To stop using it,
`plugin_manager` `remove_bundle` on `@local/free-web-search`, or disable the
`free-web-search` row and remove the `web` override in `cordis.patch.yml`. Removing the
patch override alone is enough to fall back to the shipped DeepSeek search route.

## Caveats

- It reads a public SERP page. Markup changes on Bing's side, or a CAPTCHA/consent page,
  surface as `WEB_PROVIDER_ERROR` with the attempts listed; nothing silently degrades to
  an empty result.
- Result quality and result count are Bing's, not a retrieval model's; there is no
  synthesized `content` answer, only sources with titles and snippets.
- `api.duckduckgo.com` and `html/lite.duckduckgo.com` time out from this network, so
  DuckDuckGo is not used as a fallback.
