# Compressed board serving

Serves the board bundle precompressed (brotli, gzip) and compresses large JSON
API responses. Source of truth for the behavior; OTTR-717 implements it.
Measured ground truth (Bun 1.4.4, OTTR-662 / OTTR-712, re-measured at start):
the board sent no `Content-Encoding` on any response. Board JS 550,624 B raw /
169,906 gzip / 141,565 brotli; CSS 117,770 / 22,021 / 18,897; HTML 2,462 /
1,185 / 906. One-time boot cost: build ~45 ms, compression ~930 ms.

## Serving the bundle (production)

- Boot builds the UI once per process with
  `Bun.build({ entrypoints: ["src/ui/index.html"], minify: true })`. The result
  is memoized; the first request that needs it awaits the build.
- The built HTML keeps its refs but with absolute paths: every `src="./…"` and
  `href="./…"` becomes `src="/…"` / `href="/…"`, so the nested client routes
  (`/projects/:project/tasks/:id`, `/settings/:project`) resolve assets.
- Routes `"/"`, `/projects/:project`, `/projects/:project/tasks/:id`,
  `/settings`, `/system`, `/settings/:project` serve the HTML from memory.
- Hashed outputs (JS chunk, CSS chunk, hashed icon and manifest copies) are
  served from memory by the `fetch` fallback, keyed by exact URL path. Hashed
  names (`chunk-*`, `*-<hash>.*`) cannot collide with the literal routes.
- Text outputs (HTML, JS, CSS) carry three byte variants: identity, gzip,
  brotli (node:zlib defaults, computed at build). Binary outputs (PNG,
  webmanifest) serve identity only.

## Encoding choice

- Parse `Accept-Encoding` as a comma list of `name[;q=x]`. `q=0` excludes a
  coding; a missing `q` means 1. Unknown codings and `*` are ignored.
- Pick brotli when the client accepts it with `q > 0`, else gzip, else
  identity.

## Headers

Unchanged from what Bun's HTML route sent, plus the encoding headers:

| Response | Headers |
| --- | --- |
| HTML 200 | `Cache-Control: no-cache`, `Content-Type: text/html;charset=utf-8`, `ETag`, `Vary: Accept-Encoding`, and `Content-Encoding: br`/`gzip` when compressed |
| JS/CSS 200 | `Cache-Control: public, max-age=31536000, immutable`, `Content-Type` with charset, `ETag`, `Vary: Accept-Encoding`, `Content-Encoding` when compressed |
| Binary asset 200 | immutable `Cache-Control`, `Content-Type`, `ETag`, no `Vary` (never varies) |
| 304 | `Cache-Control`, `Content-Type`, `ETag`, `Vary` where applicable; no body |

- ETags are strong and content-addressed (`"16 hex chars"`, Bun.hash). Each
  variant carries its own ETag: gzip is `"<etag>-gzip"`, brotli is
  `"<etag>-br"`. A cache can therefore never store bytes under the wrong
  encoding.
- `If-None-Match` matches (list, `*`, `W/` prefixes stripped weakly) against
  any variant ETag and answers `304` without a body; a non-match serves 200.
- The browser was told `Vary: Accept-Encoding` on every text response, so
  shared caches keep the variants apart.

## JSON compression

- `json()` bodies at or above 32 KB (`Buffer.byteLength` of the JSON text),
  when the request accepts gzip, are served gzipped with
  `Content-Encoding: gzip` and `Vary: Accept-Encoding`.
- The request's `Accept-Encoding` reaches `json()` through an
  `AsyncLocalStorage` store set in `api()`, so every API handler inherits it
  without signature changes; concurrent requests cannot cross encodings.
- Responses below the threshold, requests without gzip support, and responses
  built outside `api()` (error fallbacks, `secretJson`) stay identity.
- `Connection: close` stays on every `json()` and `secretJson` response and on
  the log responses (Bun Windows keep-alive workaround, see the comment in
  `src/app.ts`).

## Dev mode

- `NODE_ENV=development` keeps Bun's HTML dev server: the `import board from
  "./ui/index.html"` route, unbundled modules, HMR, `/_bun/…` asset paths.
  The bundle is not built; the `fetch` fallback never serves bundle assets.
- Every other value (unset, `production`) serves the memory bundle. This is
  what `bun test` sees.

## Error cases

- `Bun.build` failure: the memoized promise rejects; the HTML routes answer
  500 for the first request and every later one, and the boot warm-up logs the
  error. The API keeps working.
- Asset lookup falls through to the existing `fetch` fallback: a bundle-asset
  miss is a JSON 404 as before.

## Non-goals

- Code splitting (a later change builds on this).
- Compressing the WebSocket state frames (`publishState`) — the push path is
  not an HTTP response.
- Compressing `secretJson`, log text responses, or `/mermaid.min.js`
  (the mermaid caching card is separate work).
- Zstandard negotiation; brotli and gzip cover every current browser.
