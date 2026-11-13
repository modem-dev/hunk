# Web review client: page, assets, and policy

> **Status (2026-11-13): M3, first half.** The daemon serves a real, offline page for a live
> review. The page is a minimal shell — connection state, file count, and the first file's diff
> — that the read-only client (M4 in [`web-review-plan.md`](web-review-plan.md)) replaces. No
> CLI entry point exists yet; `--web` and `hunk session open` arrive in the second half of M3.

This records what the asset pipeline does and what the spike measured, so the M4 client is
designed around facts rather than assumptions about Pierre on the web.

## Routes

| Path                        | Serves                                         | Auth       |
| --------------------------- | ---------------------------------------------- | ---------- |
| `GET /review/<session>/`    | The page document, byte-identical for any id   | none       |
| `GET /review-assets/<name>` | One hashed script or stylesheet from the build | none       |
| `/review-api/<session>/...` | Publication, resources, events, actions        | capability |

Paths come from `packages/hunk/src/session/reviewHttpProtocol.ts`
(`HUNK_REVIEW_PAGE_PATH_PREFIX`, `HUNK_REVIEW_ASSET_PATH_PREFIX`, `parseReviewPagePath`), which
the client imports too. `/review-assets` is its own first segment, so no session id can collide
with it. The document never reveals whether a session exists and contains no secret: the
script reads the session from the path and the capability from `location.hash`, and presents
the capability only in the `hunk-review-capability` header.

`packages/hunk/src/session/broker/reviewPageServer.ts` serves both routes behind the daemon's
Host and Origin checks, after the review API, and declines every other path. GET and HEAD only
(`405` with `allow: GET, HEAD` otherwise). Assets are looked up by name in the build manifest,
never by filesystem path, so a traversal attempt has nothing to traverse to.

Headers:

- Every response: `x-content-type-options: nosniff`, `referrer-policy: no-referrer`,
  `x-frame-options: DENY`, `cross-origin-resource-policy: same-origin`. No CORS headers.
- Document: the page CSP below, `cache-control: no-store`,
  `cross-origin-opener-policy: same-origin`, and `content-type: text/html; charset=utf-8`.
- Assets: `cache-control: public, max-age=31536000, immutable` (names carry a content hash),
  `text/javascript` or `text/css` with `charset=utf-8`, and
  `default-src 'none'; frame-ancestors 'none'; base-uri 'none'` as their own policy.
- `404` for unknown names, `503` when the running build carries no page.

## Content security policy

Measured in headless Chromium by rendering one multi-hunk TypeScript diff in split and unified
layouts with `@pierre/diffs/react` and a small `@pierre/trees/react` tree, tightening the policy
until it broke, then confirmed end to end by `test/web/review-page.e2e.ts`, which fails on any
`securitypolicyviolation` or console error.

```text
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

| Directive                          | Why                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default-src 'none'`               | Nothing loads unless named below: no images, fonts, workers, frames, media, or manifests.                                                                                                                                                                                               |
| `script-src 'self'`                | The entry and its lazy chunks come from `/review-assets`. No `'unsafe-eval'`: Shiki's JavaScript regex engine uses `RegExp`, not `eval`.                                                                                                                                                |
| `style-src 'self' 'unsafe-inline'` | The page stylesheet is `'self'`. Pierre writes token colors as `style` attributes in HTML it injects, and both Pierre and Trees add `<style>` elements in their shadow roots for themes; neither is hashable. Constructable stylesheets (`adoptedStyleSheets`) are not governed by CSP. |
| `connect-src 'self'`               | `fetch` to the same-origin review API.                                                                                                                                                                                                                                                  |
| `base-uri 'none'`                  | No `<base>` can redirect the absolute asset paths.                                                                                                                                                                                                                                      |
| `form-action 'none'`               | The page submits no forms.                                                                                                                                                                                                                                                              |
| `frame-ancestors 'none'`           | The page cannot be framed (with `x-frame-options: DENY` for older engines).                                                                                                                                                                                                             |

Not needed and therefore absent: `'wasm-unsafe-eval'` (the build stubs `shiki/wasm`, see below),
`worker-src` (highlighting runs on the main thread), `img-src` (Trees icons are an inline SVG
sprite, and the document declares no favicon), and `blob:`/`data:` anywhere.
`require-trusted-types-for 'script'` is not possible: Pierre renders through `innerHTML`.

## Build and distribution

`scripts/build/build-web.ts` (`bun run build:web`) bundles `packages/hunk/src/web/main.tsx` with
`Bun.build` for browsers: minified ESM, code splitting, `[name]-[hash].[ext]` for every file, and
`process.env.NODE_ENV` set to `production`. It writes `index.html` (absolute
`/review-assets/...` references, no inline script or style) and `manifest.json` listing every
servable asset. The build refuses any output whose name the page grammar would not serve or
whose extension has no declared content type. A plugin replaces `shiki/wasm` with a module that
throws, so the 460 KB Oniguruma binary never ships and the policy never needs WASM.

| Distribution     | Where the page lives           | How                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compiled binary  | Embedded `hunk-web-assets.bin` | `build-bin.ts` builds the page and packs every file gzip-compressed into one archive passed to `bun build --compile`; the daemon finds it in `Bun.embeddedFiles` and serves the files still compressed (`content-encoding: gzip`, inflated only for a client that refuses gzip). |
| npm (`dist/npm`) | `dist/npm/web/`                | `build-npm.ts` builds into it; `main.js` reads it from beside itself. The prebuilt meta package copies it with the rest of `dist/npm`.                                                                                                                                           |
| Source checkout  | `packages/hunk/dist/web/`      | `reviewPageAssets.ts` runs `scripts/build/build-web.ts` once when the build is missing. An existing build is reused; rerun `bun run build:web` after changing the client.                                                                                                        |

Output is generated and ignored by Git. `check:pack` and `check:prebuilt-pack` read the
manifest and fail unless the document, the manifest, and every listed asset are in the pack.

## Sizes (Bun 1.4.4, Pierre diffs 1.5.2, Trees 1.0.0-beta.6)

| Measure                                                | Bytes                                                |
| ------------------------------------------------------ | ---------------------------------------------------- |
| Entry chunk (React DOM, Pierre diffs, Shiki core)      | 723 KB (212 KB gzip)                                 |
| Entry chunk when `@pierre/trees/react` is also used    | 961 KB (Trees bundles Preact)                        |
| Page stylesheet                                        | 0.5 KB                                               |
| Lazy chunks for one TypeScript diff                    | TypeScript grammar 181 KB, `pierre-dark` theme 31 KB |
| Whole build (358 files: every Shiki grammar and theme) | 9.8 MB (1.7 MB as gzip)                              |
| Added to the compiled binary                           | 1.81 MB                                              |

Grammars and themes are separate chunks because Pierre resolves them through Shiki's dynamic
imports; a page fetches only the languages and themes it shows. The largest single grammar
(Emacs Lisp) is 780 KB and is never fetched unless such a file is reviewed.

## What the M4 client must design around

- **Rendering model.** Each file is a `<diffs-container>` custom element with an open shadow
  root, an adopted base stylesheet, a theme `<style>`, and HTML injected from Shiki's HAST. Page
  CSS does not reach inside; theme through Pierre's options, its `--diffs-*` custom properties,
  or the `unsafeCSS` option (one more `<style>`, already allowed).
- **Theming.** `theme` takes a bundled name or `{ dark, light }` with `themeType: "system"`;
  custom Shiki themes are `ThemeRegistration` objects. Hunk's `AppTheme` tokens will need a
  mapping to a Shiki theme plus `--diffs-*` overrides.
- **Windowing.** Pierre ships `Virtualizer`/`useVirtualizer` and a multi-item `CodeView` with
  scroll targets and `VirtualFileMetrics`. M4 should evaluate `CodeView` against the plan's
  "reserve heights from `splitLineCount`/`unifiedLineCount`" approach before writing its own.
- **Inline notes.** `lineAnnotations` plus `renderAnnotation` render React content in the diff
  flow beside a line, the slot for note cards.
- **Line selection.** `enableLineSelection` with `onLineSelectionStart`, `onLineSelectionChange`,
  `onLineSelectionEnd`, and `onLineSelected`, plus a controlled `selectedLines` range and
  `renderGutterUtility` — the hooks for mouse line-range comments.
- **Workers.** Highlighting runs on the main thread. Pierre's `WorkerPoolContextProvider` takes
  a `workerFactory: () => Worker`; adopting it needs a second build entry for
  `@pierre/diffs/worker/worker.js`, an asset name in the manifest, and `worker-src 'self'`.
- **Input.** `PatchDiff` takes one file's patch text, which is exactly the `patch` resource; the
  shell reads it in 256 KB ranged windows and checks the published SHA-256 with Web Crypto.
- **Trees.** `useFileTree({ paths, initialExpansion, search })` plus `<FileTree model>`, keyed by
  canonical path strings, with `setGitStatus` and icon configuration. It renders through Preact
  inside a shadow root, costs about 240 KB of entry chunk, and is still a beta: pinned exactly.
  `1.0.0` was published three days before this spike and is held back by the repository's
  seven-day `minimumReleaseAge`; `1.0.0-beta.6` is the newest eligible release.

## Tests

- `packages/hunk/src/session/broker/reviewPageServer.test.ts` — headers, content types, 404s,
  traversal, HEAD, methods, gzip negotiation, identical documents, no capability-shaped token,
  and the route inside a real daemon behind its Host/Origin checks.
- `packages/hunk/src/session/broker/reviewPageAssets.test.ts` — manifest grammar, directory and
  archive stores.
- `packages/hunk/src/web/reviewShellClient.test.ts` — the shell against the real review API.
- `test/web/review-page.e2e.ts` (`bun run build:web && bun run test:web`) — Chromium against a
  daemon and session run from source, asserting connection, file count, a highlighted Pierre
  diff, and zero CSP violations or console errors. The session is a test fixture
  (`test/web/fixtures/review-session.ts`) built from the real bootstrap loader, review runtime,
  and session bridge, because only the owning process holds the capability and no headless
  runner exists until M1 lands. Set `HUNK_TEST_EXECUTABLE` to a compiled binary (after
  `bun run build:bin`) to run the daemon from it and exercise the embedded archive.
