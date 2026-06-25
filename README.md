# pi-webfetch

A [pi](https://github.com/earendil-works) extension that fetches a URL and
returns readable content for the LLM — **Markdown first**, with HTML and plain
text on demand, plus a **headless-browser fallback** for client-side-rendered
apps.

## Why

Most "fetch a web page" tools hand the model raw HTML, which is expensive on
context and noisy. `pi-webfetch` instead:

1. Asks the server for Markdown (`Accept: text/markdown`). Many docs sites
   (Cloudflare, Astro Starlight, etc.) serve a clean Markdown variant — far
   cheaper than HTML.
2. Falls back to converting HTML to Markdown with
   [turndown](https://github.com/mixmark-io/turndown).
3. Detects empty client-side-rendered shells (React + Vite, Next.js CSR,
   Gatsby) and re-renders them with an already-installed headless browser
   before converting.

## Install

Add it to your pi config as an extension. From npm-style install:

```sh
npm install @jilles/pi-webfetch
```

Then reference `./index.ts` (or the package) from your pi extension config.
The package already declares the extension entry point in `package.json`:

```json
{
  "pi": { "extensions": ["./index.ts"] }
}
```

### Optional: headless rendering

Rendering JS-heavy pages is **opt-in by capability** — it only happens if a
browser is available, and nothing is bundled or downloaded:

- The preferred path uses [`playwright-core`](https://www.npmjs.com/package/playwright-core),
  declared as an **optional dependency** (~12MB, downloads **no** Chromium on
  install). It drives an *already-installed* browser via Playwright "channels"
  (`chrome`, `chrome-beta`, `msedge`, `chromium`).
- If `playwright-core` isn't installed or can't launch a browser, it falls back
  to spawning the system Chrome directly with `--headless=new --dump-dom`
  (zero dependencies).
- If no browser is found at all, the curl result is used as-is and the result
  is flagged as a possible client-side app.

You can point at a specific Chrome/Chromium/Edge binary with the
`PI_WEBFETCH_CHROME` environment variable.

## Tool: `webfetch`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | — | Absolute `http`/`https` URL to fetch. |
| `format` | `auto` \| `markdown` \| `html` \| `text` | `auto` | `auto`: prefer Markdown, fall back to converted/stripped text. `markdown`: request the Markdown variant. `html`: return raw HTML. `text`: strip HTML to plain text. |
| `render` | `auto` \| `always` \| `never` | `auto` | Headless-browser rendering. `auto`: only render when the page looks client-side-rendered. `always`: always render. `never`: never render (curl only). Ignored when `format=html`. |

Output is truncated to pi's standard limits; the full body is written to a temp
file when truncated, with the path included in the result.

## How rendering decides to fire

```
curl (Accept: text/markdown)
  └─ HTML body?
       └─ looksClientSideRendered()?   (empty mount node + module scripts,
            └─ render=auto  → render   visible text < 200 chars, vite markers)
       render=always (any HTML)        → render
       render=never / format=html      → skip
```

`looksClientSideRendered()` parses a real DOM (via `@mixmark-io/domino`, the
same parser turndown uses) rather than regex.

## Example

A Vite SPA where `curl` only returns:

```html
<body><div id="root"></div></body>
```

…is re-rendered to its hydrated DOM and converted to Markdown:

```
# https://example-spa.dev/
[markdown | HTTP 200 | text/html | 0.5KB]
[rendered with headless browser (playwright)]

# Hello World
```

## Development

```sh
npm install
```

The pi runtime provides `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai`, and `typebox` at load time; only `turndown`,
`@mixmark-io/domino`, and the optional `playwright-core` are real dependencies.

## License

MIT
