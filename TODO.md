# webfetch TODO

## Headless browser fallback for client-side-rendered apps — DONE

When `curl` fetches a client-side-rendered app (e.g. React + Vite, Next.js
CSR, Gatsby), the returned HTML is an empty shell: a mount node like
`<div id="root"></div>` plus module scripts, and almost no static content.
turndown then produces near-empty Markdown.

`looksClientSideRendered()` in `index.ts` detects this case. When it fires we
now re-render the DOM with an already-installed headless browser and convert
the rendered HTML instead.

### How it works
- **`playwright-core`** is an `optionalDependency` (~12MB, installs in ~2s and
  downloads **no** Chromium). It drives an already-installed browser via
  Playwright "channels" (`chrome`, `chrome-beta`, `msedge`, `chromium`) or a
  discovered executable path. See `renderWithPlaywright()`.
- If `playwright-core` is absent or can't launch any browser, we fall back to
  spawning the system Chrome directly with `--headless=new --dump-dom`
  (`renderWithChromeDumpDom()`, zero dependencies). Chrome is located by
  `findChromeExecutable()` (override with `PI_WEBFETCH_CHROME`).
- If no browser is available at all, the curl result is used as-is and the
  "client-side app?" warning is kept (with the render error, if any).

### Behaviour
- [x] Re-render via a headless browser when `maybeClientSideApp` and
      `format !== "html"`, then convert with turndown.
- [x] Prefer an already-installed browser; never bundle/download Chromium.
- [x] Lazy: only `import("playwright-core")` / spawn a browser on the render
      path.
- [x] `render` parameter: `auto` (default, only on CSR detection), `always`,
      `never`.
- [x] Wait strategy: Playwright uses `waitUntil: "networkidle"` with a
      `RENDER_TIMEOUT` budget (falls back to whatever loaded on timeout);
      chrome `--dump-dom` uses `--virtual-time-budget`.
- [x] Honor `ctx.signal` for cancellation (closes the browser on abort).
- [x] Browser dep is optional, so the extension still works curl-only when no
      browser is present.

### Possible future tweaks
- Configurable wait selector (wait for a specific element before snapshotting).
- PATH-based Chrome discovery on Linux (currently a fixed candidate list +
  `PI_WEBFETCH_CHROME` override).

### Notes
- Detection heuristic lives in `looksClientSideRendered()`. It parses a real
  DOM with `@mixmark-io/domino` (the parser turndown already uses) rather than
  regex; tune thresholds (visible text length < 200, empty mount node, module
  scripts, vite markers) as we see real-world cases.
- After a successful render the "may be incomplete" warning is cleared, since
  the rendered DOM is what we converted (even if the shell heuristic would
  still match the small rendered page).
