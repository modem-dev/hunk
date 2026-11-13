# Web review client: page, assets, and policy

> **Status (2026-11-13): M4 read-only page with shared state.** The daemon serves a real,
> offline page for a live review: toolbar, files sidebar, and one top-to-bottom stream of every
> file with the review's notes, agent marks, and the session's title, theme, view, and keymap,
> driven by the terminal's shortcuts. Authoring notes is the next step; the page opens through
> the hidden `--web` flag ([`web-review-plan.md`](web-review-plan.md)).

This records how the client is built and what the spike measured about Pierre on the web.

## Client modules and state ownership

```text
packages/hunk/src/web/
  main.tsx                     entry; starts the session for this page's address
  app/ReviewApp.tsx            composes the page; owns view preferences, theme, and commands
  app/Toolbar.tsx              title, counts, totals, status; layout/wrap/line-number toggles
  app/ThemeMenu.tsx            the theme button and its listbox
  commands/webCommandTable.ts  every catalogued command classified; handlers by catalog id
  commands/keyboard.ts         DOM key events -> shared chord grammar; browser-reserved chords
  commands/useWebKeyboard.ts   the one keydown listener that runs page commands
  sidebar/FileSidebar.tsx      flat mode (shared projection); lazy-loads tree mode
  sidebar/TreeSidebar.tsx      tree mode over @pierre/trees, in review order
  stream/ReviewStream.tsx      the windowed stream, reveals, viewport anchoring, scrolling
  stream/hunkGeometry.ts       hunk and gap rows from the model; their measured bounds
  stream/FileSection.tsx       sticky header, placeholders, reserved heights
  stream/fileProjection.ts     ReviewFileV1 -> Pierre metadata, gaps, reserved rows
  stream/PierreFileView.tsx    drives Pierre's vanilla FileDiff and the page's gap separators
  theme/themeIndex.ts          built-in themes as CSS custom properties; per-browser choice
  view/viewPreferences.ts      layout/wrap/line numbers/sidebar, per browser
  session/reviewSession.ts     reads the page address once; wires and owns the pieces below
  transport/apiClient.ts       requests with the capability header; ranged, verified reads
  transport/eventReader.ts     fetch-stream SSE records -> shared event contract -> events
  transport/eventStream.ts     keeps the stream open; one shared reconnect scheduler
  transport/webCryptoDigest.ts Web Crypto SHA-256 as the assemblers' async digest
  mirror/reviewMirror.ts       orders publications; loads each generation's files
  mirror/sharedStateMirror.ts  fetches and orders shared-state snapshots
  notes/noteProjection.ts      places a file's visible notes per line; titles and thread depth
  notes/noteCards.ts           note cards as DOM for Pierre's line annotations
  notes/stmlDom.ts             STML markup to DOM through the shared parser and roles
  stream/highlightGeometry.ts  agent attention marks measured over drawn characters
  mirror/fileIndex.ts          per-file index entries and the pluggable index source
  store/clientReviewStore.ts   the page's local core/review store and gap source loads
```

- **Capability.** Read from `location.hash` once (`reviewSession.ts`) and held only by the API
  client, which sends it in the `hunk-review-capability` header. It never enters a path, a
  query string, a log, or storage.
- **Transport** (`apiClient.ts`, `eventReader.ts`, `eventStream.ts`) owns requests, the event
  stream, and reconnects. Resource windows are assembled by the shared `ReviewChunkAssembler`
  and verified with Web Crypto through `finishAsync`; events are decoded by the shared
  `reviewEventProtocol.ts` parsers and `ReviewEventAssembler`. Reconnects use
  `createReconnectScheduler` from `@hunk/session-broker-core/lifecycle` (500 ms doubling to
  8 s, reset by any delivered event); the stream stops for good on `disconnect` or
  `unauthorized`. Failures are `ReviewApiError` carrying the review vocabulary's code, shown
  through `reviewErrorCatalog`.
- **Mirror** (`reviewMirror.ts`) owns the published position and the files. It classifies
  every publication with `classifyReviewPublication`; a gap (a reload, or the first
  publication) loads that generation's `canonical-file` resources in catalog order with
  bounded parallelism, through one `createSupersedeQueue`, parsing each with
  `parseCanonicalReviewFile`. The first generation is published progressively; a later one
  replaces the shown document only once complete, and a failed reload keeps the old one.
  Per-file index entries (path, change kind, stats, flags, line counts, hunk count) are
  projected from canonical files today; `ReviewFileIndexSource` lets the shared-state route
  supply them up front.
- **Store** (`clientReviewStore.ts`) owns page-local review state: a `core/review`
  `ReviewStore` over the mirrored document. Selection, reveal, and expansion are local by
  product decision; `selection/*` and `expansion/toggle` are applied with
  `applyReviewIntent` and never sent. Shared intents are refused until the page can author
  them. Each new document is adopted with `document/reconcile`, so selection and expansion
  survive a reload by file key. Gap source is loaded on demand from the file's `source`
  resource into the store's source-status vocabulary.
- **Shared state** (`sharedStateMirror.ts`). Every publication is offered to it before the file
  mirror; it fetches `GET /state` when the generation changes or `sharedStateRevision` moves,
  never for a selection moving elsewhere, orders bodies by `classifyReviewPublication` and then
  by shared revision, supersedes in-flight fetches with the shared queue, and validates with
  `parseReviewSharedState`. The file mirror asks it for each generation's file index, which
  fixes document order and fills the sidebar, totals, and reserved heights before any canonical
  file loads (catalog order is only the fallback when the route fails). The store adopts a
  snapshot once the file mirror shows its generation: `filter/set`, `notes/set-visibility`, and
  the stored notes replaced with the snapshot's live and reviewer notes, resolution kept;
  sidecar annotations stay out of the store, as in every surface, and reach annotated navigation
  through `buildReviewAnnotationIndexFromNotes`.
- **Digests.** A resource descriptor in the published catalog is usually unmeasured, and the
  HTTP surface sends no digest header, so for those reads the client checks size and window
  rules and relies on the daemon having verified the bytes. Measured descriptors are verified
  end to end.

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

| Distribution     | Where the page lives           | How                                                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compiled binary  | Embedded `hunk-web-assets.bin` | `build-bin.ts` builds the page and packs every file gzip-compressed into one archive passed to `bun build --compile`; the daemon finds it in `Bun.embeddedFiles` and serves the files still compressed (`content-encoding: gzip`, inflated only for a client that refuses gzip).                               |
| npm (`dist/npm`) | `dist/npm/web/`                | `build-npm.ts` builds into it; `main.js` reads it from beside itself. The prebuilt meta package copies it with the rest of `dist/npm`.                                                                                                                                                                         |
| Source checkout  | `packages/hunk/dist/web/`      | `reviewPageAssets.ts` runs `scripts/build/build-web.ts` once when the build is missing. An existing build is reused; rerun `bun run build:web` after changing the client, and a running daemon serves the new build: it re-reads `manifest.json` on every lookup, so it never serves a replaced build's names. |

Output is generated and ignored by Git. `check:pack` and `check:prebuilt-pack` read the
manifest and fail unless the document, the manifest, and every listed asset are in the pack.

## Sizes (Bun 1.4.4, Pierre diffs 1.5.2, Trees 1.0.0-beta.6)

| Measure                                                 | Bytes                                             |
| ------------------------------------------------------- | ------------------------------------------------- |
| Entry chunk (React DOM, Pierre diffs, Shiki core, page) | 820 KB (243 KB gzip)                              |
| Tree sidebar chunk (`@pierre/trees`, Preact), lazy      | about 240 KB                                      |
| Theme index                                             | 60 KB (11 KB gzip)                                |
| Page stylesheet                                         | 8 KB                                              |
| Lazy chunks for one TypeScript diff                     | TypeScript grammar 181 KB, its Shiki theme ~31 KB |
| Whole build (every Shiki grammar and theme)             | 10.2 MB (1.8 MB as gzip)                          |
| Added to the compiled binary                            | about 1.8 MB                                      |

Grammars and themes are separate chunks because Pierre resolves them through Shiki's dynamic
imports; a page fetches only the languages and themes it shows. The largest single grammar
(Emacs Lisp) is 780 KB and is never fetched unless such a file is reviewed.

## The review page

- **Regions.** The toolbar mirrors the terminal's title line — title, file count, total
  `+A -D` — plus connection and load state; view controls sit on the right. The sidebar is
  navigation only: choosing a file is a `selection/select-file` with a file-top reveal that
  scrolls the stream, never a filter. Scrolling reports the hunk at the viewport's middle back
  as `selection/anchor`, which moves the sidebar highlight and the selection and nothing else.
  Tree rows are laid out as the terminal's are — change letter, name, badges, no file-type
  icon — with the letter from `reviewFileChangeGlyph`, through stylesheet rules generated
  from it into the tree's shadow root.
- **Shared with the terminal.** File names, `old -> new` labels, state suffixes, change-kind
  letters, `*N`/`+N`/`-N` badges, and the flat and tree projections come from
  `core/review/fileLabels.ts`, which the terminal's `ui/lib/files.ts` now delegates to (audit
  E1). Gap addresses, the empty-file reason, and gap expansion come from `core/review`;
  `reviewFileWithExpandedGaps` folds an expanded gap into its hunk as context, which is the
  form a whole-file renderer needs. Auto layout uses `DEFAULT_AUTO_SPLIT_MIN_WIDTH` in measured
  monospace columns, and Pierre gets the terminal's own highlight options
  (`ui/diff/highlightRenderOptions.ts`: `word-alt`, the tokenizing bound). Wording of
  placeholders and gap rows is the page's own, as each surface's is.
- **Gaps.** Pierre's React wrapper cannot host custom hunk separators, so each file drives
  Pierre's vanilla `FileDiff` with a separator function that returns page-owned buttons. A
  click applies `expansion/toggle` locally; the store loads the `source` resource and the plan
  folds the gap in, with loading, error, and too-large states from the shared source-status
  vocabulary. Pierre's own expansion is never used, and `collapsedContextThreshold: 0` keeps
  every gap the model addresses collapsed. A folded-in gap leaves no separator, so the page
  overlays its own collapse control on the gap's first line, and the file header offers "Hide
  expanded lines" for all of them.
- **Windowing.** Every file is a section whose body height is reserved from the plan's row
  count (split or unified, minus folded gap lines) until mounted. Sections mount Pierre within
  1.5 viewports of the visible area and unmount beyond it, keeping their last measured height.
  Native scroll anchoring absorbs height changes above the reader, and a reload re-pins the
  top file and offset for a moment while files re-render. Pierre's `Virtualizer`/`CodeView`
  were not used: they own scrolling of the whole document, which would put sticky headers,
  placeholders, and the sidebar jump inside Pierre.
- **Theme.** `build-web.ts` writes every built-in theme's resolved `AppTheme` tokens, from
  `ui/themes.ts` itself, to `themes-<hash>.json` (60 KB, 11 KB gzip), named in the document's
  `<meta name="hunk-theme-index">`. The page sets them as `--hunk-*` properties and maps the
  same tokens onto Pierre's `--diffs-*-override` and the tree's `--trees-*-override` properties;
  Pierre highlights with the theme's Shiki theme. The `terminal` theme is omitted. The default
  is GitHub dark or light by `prefers-color-scheme`; a choice is kept in `localStorage`.
- **Not rendered yet.** Moved-line marks (`lineMoveKinds`): Pierre 1.5.2 exposes no per-line
  class or decoration hook in its diff renderer for them (rechecked for the keyboard change; its
  types mention "moved" only for renamed files). The changeset title is not on the wire, so
  the toolbar says "Hunk review" until presentation defaults arrive.

## Notes, agent marks, and presentation defaults

- **Notes** are read-only cards in the diff flow, one Pierre line annotation per anchor line,
  placed by `noteProjection.ts`: visibility and threads from
  `selectVisibleThreadedStoredReviewNotes` and `reviewNoteVisibleByPolicy`, the line from
  `reviewNoteAnchorLine`, and the owner hunk's canonical line when that line sits in collapsed
  context. A card shows the terminal's title (`Your note`, the author, or `Agent note`, with the
  age), its lines (`R12–R14`), a stale mark, then the STML body or the summary and muted
  rationale; replies indent under their root, capped at three levels. Titles, ages, and line
  labels are `core/review/noteLabels.ts`, which the terminal's inline notes now use too. Pierre
  puts an annotation below its line; the terminal draws a card above its range.
- **Sidebar badges** count each file's visible notes (`*N`). When the session left sidecar
  notes out of the snapshot (`omittedSidecarNotes`), the toolbar says how many. A note written
  through the review link (`originalSource: "browser"`) is titled by its author, or "Browser
  note", never "Your note": anyone holding the link may have written it.
- **Agent marks** are measured over the characters Pierre drew (`highlightGeometry.ts`) and
  painted in their tone; Pierre has no character-range decoration hook.
- **Agent reveal.** When `agentReveal.token` grows, the page selects its hunk and reveals its
  line or note card. The token present when the page first loads is history and moves nothing.
- **Focus report.** When the reader's scroll settles, the page posts a debounced
  `selection/anchor` as a `browser` actor with a per-tab `clientId` (never stored), so a
  headless session's `hunk session context` reports where the reader is. Failures are dropped,
  nothing is sent while a newer generation loads, and no other selection action is ever sent.
- **Presentation defaults.** The toolbar shows `presentation.title` (the source label is its
  tooltip) and the shared filter. The session's theme, view options, and resolved keymap are
  the starting point; this browser's own theme and view choices win and persist, and the theme
  menu's "Use session theme" clears the override. A custom session theme applies its tokens;
  code highlights with its base Shiki theme, or GitHub's for its appearance, because Pierre
  takes a highlight theme by name or as a whole Shiki theme, so the theme's `syntaxColors` and
  scope overrides are not applied in the browser.
- **Shared filter.** Files the session's filter hides leave the stream and the sidebar, and the
  planner walks the same visible stream.

## Commands and keyboard

- **One table, keyed by the catalog.** `commands/webCommandTable.ts` classifies all 55
  commands of `core/run/commandCatalog.ts` in one record keyed by `AppCommandId`, so a new
  catalog entry fails to typecheck, and fails `webCommandTable.test.ts`, until the page decides
  about it. Identity, titles, and chords come from the catalog; the page supplies handlers
  only for what it implements.

  | Class                              | Count | Commands                                                                                                                                                      |
  | ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Implemented                        | 22    | `[` `]` `,` `.`, `z`, step/half/page/top/bottom scrolling, code left/right, layout `1` `2` `0`, `s`, `l`, `w`, `t`                                            |
  | Deferred: notes                    | 12    | start/edit/reply/delete/save note, previous/next note, toggle agent notes, annotated hunk and file navigation (`{` `}`)                                       |
  | Deferred: filter, palette, refresh | 3     | focus filter; help (`?`) with the palette; refresh until the page has its refresh control                                                                     |
  | Deferred: renderer                 | 1     | hunk headers (`m`): Pierre draws `@@` rows only in its built-in separator modes, which cannot coexist with the page's gap separators                          |
  | Host-only (audit F4)               | 4     | quit, edit in `$EDITOR`, agent skill, feedback; extension commands are never in the table                                                                     |
  | Terminal-only                      | 13    | focus-area toggle (Tab is native), visual selection and copy (native selection), line-cursor align and styles, menu bar, copy decorations, file presentations |

- **Semantic commands lower, never re-derive.** Hunk and file navigation and the gap toggle go
  through `lowerAppCommandToReviewIntent` and `applyReviewIntent` on the page's local store,
  so `]` plans the same move, with the same clamp and cross-file rules, as in the terminal.
- **Keymap.** Chords are the shared grammar (`extension-api/keys.ts`) and labels the shared
  `core/run/keyChordLabels.ts`, which the terminal's `ui/lib/keymap.ts` now re-exports (audit
  F3). The page starts from the catalog's default chords; the host's resolved keymap from the
  shared-state route replaces them through the same `WebKeymap` shape. `keyboard.ts` maps a DOM
  `KeyboardEvent` onto the grammar's structural key event (Caps Lock `G` is `G`, never `g`) and
  masks what the browser owns: every Ctrl, Cmd, or Alt chord (so `ctrl+d`/`ctrl+u` stay the
  browser's and `d`/`u` page), Tab, and the function keys. Nothing fires in a text field,
  Space and Enter stay with a focused button, and arrow and paging keys stay with a focused
  composite widget (the layout radio group, the theme listbox, the files tree).
- **Reveal and anchoring.** A `hunk` reveal puts the selected hunk just under the sticky file
  header, `file-top` puts the header at the top, `none` leaves the viewport alone. A hunk in a
  file that has not mounted is scrolled to by estimate and corrected when the file draws. When
  the reader scrolls by hand and the scroll settles, the hunk nearest the viewport's middle
  becomes the selection through `selection/anchor` — the terminal's policy, now
  `reviewHunkIndexAtOffset` in `core/review/viewportAnchor.ts` (audit B11) — so the next `]`
  continues from there. A target the page just revealed holds the selection while it stays
  where the reveal put it, so files mounting nearby cannot steal it.
- **Mouse parity.** Clicking a hunk's rows selects it without scrolling; clicking a sidebar row
  selects the file and jumps. The selected hunk carries the terminal's accent rail, measured
  from the rows Pierre drew for the hunk's model rows (`hunkGeometry.ts`); expanded gap lines
  are not part of the hunk. Focus runs toolbar, sidebar, stream, with visible rings.
- **Gap affordances.** A collapsed gap that can expand shows the terminal's `▾`; context that
  cannot shows `··· ···`. An expanded gap is collapsible in place from a "Hide N unchanged
  lines" control over its first line (the terminal's wording), as well as from the header.

## Pierre findings that shaped the client

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
- **Input.** The shared `ReviewFileV1` is already Pierre-shaped (hunks, content blocks, line
  arrays, row counts), so the page hands Pierre parsed metadata from the canonical file instead
  of re-parsing the `patch` resource. Pierre treats metadata with an unchanged `cacheKey` as
  the same diff, so the projection derives the key from the content identity plus the filled
  gaps.
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
- `packages/hunk/src/web/**/*.test.ts` — the API client (window boundaries, digest and size
  refusals, bounded parallelism, abort), event reader (SSE splitting, chunked reassembly,
  digest refusal), event stream (backoff with a fake clock, terminal states), mirror (ordering,
  progressive load, supersede, failed reload), and store (local intents, gap source, reload).
- `test/review-conformance/` registers the browser mirror as an ordering consumer, the
  browser event reader as an event consumer, and the browser file projection as a geometry
  consumer (gaps, empty reasons, and the rows an expanded gap puts in Pierre's metadata).
- `test/web/review-stream.e2e.ts` drives a rich review (rename, new, deleted, binary,
  too-large, gaps, a non-ASCII path, many files): progressive load, sidebar and stream jumps,
  layout and theme switching, gap expansion, reload keeping the reader's place, and axe;
  `test/web/review-large.e2e.ts` keeps a 2,000-file review responsive.
  `test/web/review-screenshots.e2e.ts` captures the page when `HUNK_WEB_SCREENSHOT_DIR` is set.
  `test/web/review-notes.e2e.ts` drives a headless session with the agent's own commands:
  sidecar and STML notes, live comments added, batched, replied to (and a reviewer reply),
  removed, and cleared; `hunk session navigate`; agent highlights; annotated navigation; a
  custom theme from config with the session-theme override; the reader's position reported to
  `hunk session context`; notes and position across a reload; and axe with notes showing.
  `test/web/review-languages.e2e.ts` highlights `.mts` and `.cts` files.
  `test/web/review-keyboard.e2e.ts` drives the page from the keyboard: hunk and file
  navigation with reveals under the sticky header, scroll-then-navigate anchoring, paging,
  the view keys and theme menu, the gap toggle, click-to-select, input-focus and
  browser-shortcut suppression, focus order, and axe with the theme menu open.
  `bun run test:web` builds the page first, so a stale bundle is never what runs.
- `test/web/review-page.e2e.ts` (`bun run build:web && bun run test:web`) — Chromium against a
  daemon and session run from source, asserting connection, file count, a highlighted Pierre
  diff, and zero CSP violations or console errors. Every page test runs Hunk itself as the
  session: `hunk patch <file> --web`, or `hunk diff --staged --web` in a git repository that
  `test/web/fixtures/rich-review.ts` writes (with an agent-context sidecar fixing the review
  order), and reloads it with `hunk session reload`. Set `HUNK_TEST_EXECUTABLE` to a compiled
  binary (after `bun run build:bin`) to run the daemon and session from it and exercise the
  embedded archive.
