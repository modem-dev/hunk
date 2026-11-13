# Web review plan

> **Status (2026-11-13): accepted; implementation in progress.** This document revises Phases 5
> and 6 of [`browser-review-rebuild.md`](browser-review-rebuild.md) for decisions made after that
> plan was written, and adds the web-only tools that plan never scoped. Phases 0–4 there are
> landed and stay as they are. Each milestone lands as a stack of pull requests.

A browser client for Hunk reviews, served by the existing session daemon. It keeps Hunk's
structure, keys, and themes so terminal users recognize it, and adds tools a terminal cannot
offer. It must work with no terminal UI running.

## Decisions

| Question                     | Decision                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs a terminal UI running? | No. `hunk diff --web` runs headless from the first release.                                                                                         |
| Headless process model       | The command stays in the foreground as the review's owner until Ctrl+C. It registers with the daemon, prints the review URL, and opens the browser. |
| Selection across surfaces    | Fully independent. A browser never tracks a terminal's position, and a terminal never tracks a browser's. Notes, filter, and content still sync.    |
| Visual fidelity              | Same regions, keys, command names, and themes as the terminal. Chrome is web-native: toolbar and command palette, no text menu bar.                 |
| Theme                        | The browser starts on the session's resolved theme, custom themes included. A per-browser picker can override it without changing the terminal.     |
| Surfaces in scope            | The review stream only. History, status, and `hunk open` stay terminal-only.                                                                        |
| Watching                     | `--web` watches its input and reloads by default. A new `--no-watch` flag turns that off.                                                           |
| Sidebar tree                 | `@pierre/trees`, accepted as a shipped dependency while it is in beta.                                                                              |
| Release flag                 | A plain `--web` flag, not gated behind `--experimental`.                                                                                            |
| Web-only tools, first cut    | Viewed files and progress, notes panel, mouse line-range comments, command palette and go-to-file, stats overview, rich previews, minimap.          |
| Deferred web-only tools      | Guide view, diff-aware find.                                                                                                                        |

## Assumptions to confirm

These follow from the decisions but were not asked directly. Each changes work below if wrong.

1. **Agent-directed navigation moves every surface.** `hunk session navigate` is an explicit
   "show the reviewer this" request, so it scrolls the browser and the terminal alike. Human
   navigation moves only the surface it happened on.
2. **Filter and agent-note visibility stay shared**, as the seam audit already classifies them
   (G1). Layout, wrap, line numbers, theme override, sidebar width, and gap expansion are
   per-browser.
3. **Composers are per-client.** The shared store holds one draft slot, which two independent
   surfaces would fight over. The browser keeps drafts locally and saves through new intents
   that carry the body and target in one action.
4. **Viewed-file state is shared semantic state**, keyed by `contentIdentity`, so a reload
   un-views exactly the files whose content changed and agents can read review progress. It
   lasts for the session; persisting it across runs is a later decision.
5. **Loopback only.** The `--tailscale` idea in the earlier plan is out of scope here.
6. **`react-dom`, `@pierre/diffs/react`, and `@pierre/trees` are the only new client
   dependencies**, as the existing web boundary gate already allows. T3 Code ships the same
   Pierre pair.

## What exists and what is missing

Landed and reused unchanged:

- `core/review/` — `ReviewDocumentV1`, the store, reducer, intents, selectors, geometry, and
  navigation planning. Renderer-free and gated platform-neutral.
- `session/review{Protocol,HttpProtocol,EventProtocol,ErrorCatalog}.ts` — browser-safe wire
  schema, routes, SSE framing, and user-facing error messages.
- `session/broker/browserReviewServer.ts` — publication, digest-verified resource reads, SSE,
  and action submission under `/review-api/<session>/`, inside the one loopback daemon.
  Authorization is a session-minted capability carried in the URL fragment.
- `core/run/commandCatalog.ts` — command ids, titles, default chords, and resolution locus.
- `test/review-conformance/` — the fixture corpus every new consumer must register against.

Missing:

1. **The review lives in the terminal UI.** `createReviewStore` is called from
   `ui/hooks/useTerminalReview.ts`, and reload and watch are coordinated by `AppHost` and React
   hooks. No review exists unless OpenTUI is mounted.
2. **Live state has no transport.** An HTTP publication is a position plus a resource catalog.
   Notes, filter, note visibility, and agent highlights do not reach a browser.
3. **No client and no served page.** `packages/hunk/src/web/` does not exist; the reserved
   `/review/<session>/` path has no handler.
4. **No asset pipeline.** The compiled binary embeds `main.tsx` and the highlight worker only.
5. **No entry point.** No `--web` flag, no `hunk session open`.

## Architecture

```text
hunk diff --web                         hunk diff
  headless runner (app/)                  AppHost / App (ui/)
        \                                   /
         ReviewSessionHost (app/review/)  ── owns ReviewStore, ReviewProducer,
           intent facts, note ingestion,     reload and watch, bridge handlers
           source loading
                    │  existing session websocket
        hunk daemon 127.0.0.1:47657
          /review/<session>/            static client, embedded in the binary
          /review-api/<session>/...     publication · state · resources · events · actions
                    │  fetch + streamed SSE, capability header
        browser client (packages/hunk/src/web/)
          mirror ── local client store (core reducer and selectors)
          React + @pierre/diffs/react + @pierre/trees
```

The browser runs the same `core/review` reducer and selectors over a mirrored document. It
applies selection and navigation intents to its own local state and forwards shared intents
(notes, filter, note visibility, viewed) to the producer. No review semantics are re-derived in
`web/`; the conformance harness and boundary gates enforce that.

## Milestones

Each milestone is a stack of small PRs. M1–M3 change no user-reachable behavior and ship empty
changesets. M5 carries the `minor` changeset that announces the feature.

### M0 — Plan of record (done)

- Phases 5–6 of `browser-review-rebuild.md` point here.
- `browser-review-seam-audit.md` records the G1 (option classification), G2 (selection and
  authorship policy), and E2 (theme) decisions.

### M1 — Headless review host

The prerequisite for standalone mode, and the largest refactor in the plan.

1. **Store ownership.** Add `app/review/reviewSessionHost.ts`, a non-React owner of the
   `ReviewStore`: intent application with caller facts (note ids, timestamps, the annotation
   index), live-comment and sidecar-note ingestion, gap-expansion source loading, agent line
   highlights, and the note summaries the session export publishes. `useTerminalReview`
   becomes a subscriber that keeps only terminal projection and the measured line cursor.
2. **Reload and watch.** Extract a renderer-free reload coordinator from `AppHost`,
   `useCurrentReviewRefreshController`, and `useWatchedInput`. `AppHost` keeps the React commit
   gate and drives the coordinator; the headless runner drives the same coordinator directly.
3. **Headless runner.** `app/` gains a runner that takes the existing startup plan through
   extension and session bootstrap, mounts the host and `createReviewSessionRuntime`, wires
   `createHunkSessionBridge` handlers straight to the host, prints the review URL, and waits
   for SIGINT. It imports nothing from `ui/` or OpenTUI.

Terminal-only concerns need an explicit headless answer in this milestone:

- Repo-local extension trust prompts: untrusted extensions stay disabled and a notice is printed.
- Extension panes, dialogs, and commands: not available headless.
- `noteMarkupWidth`: the host reports a fixed nominal width, since a browser reflows.
- `hunk session context`: in a headless session, the selection agents read is the browser's
  reported position (`selection/anchor`). In a terminal session it stays the terminal's.

Gate: the existing PTY suite and `test/session/` pass untouched; `test/session/` also runs
every `hunk session` command against a headless host; the host registers as a conformance
consumer.

### M2 — State transport and protocol additions

Server-side only, tested with plain `fetch`.

- **Shared-state snapshot.** A JSON-safe `ReviewSharedStateV1`: stored notes and sidecar
  annotations normalized to `ReviewNoteV1`, filter, note visibility, viewed set, agent
  highlights, and the latest agent reveal request. Served at
  `GET /review-api/<session>/state` for one `(generation, stateRevision)`, chunked and
  digest-verified through the existing mirror and `ReviewChunkAssembler`. The existing SSE
  `publication` event already announces each new `stateRevision`; the client refetches.
- **Presentation defaults.** Registration metadata carries the session's resolved theme tokens,
  syntax theme, resolved keymap, and view defaults (layout, wrap, line numbers), so the browser
  starts where the host's config chain ended (G1).
- **Actor policy (G2).** The producer ignores `selection/*` from `browser` actors in terminal
  sessions and accepts `selection/anchor` from them in headless sessions. Agent navigation
  records a reveal request every surface honors. Note authorship defaults from the actor.
- **New intents.** Direct create, edit, and reply for user notes (body and target in one
  action, no shared draft), and `files/set-viewed`. The wire vocabulary derives them
  automatically; each needs a parser, reducer case, and fixtures.
- **Byte resources.** A `bytes` resource kind per side, backed by the existing
  `DiffFile.byteFetcher`, for image previews.
- **Refresh.** A `review/refresh` action that reloads the session's current input with no
  caller-supplied arguments, as the first entry on the host-command allowlist (F4). Headless
  sessions need it because no terminal `r` key exists.
- **Wire versions.** Bump `HUNK_SESSION_DAEMON_VERSION`, regenerate the session-wire fixture,
  and delete the previous one in the same PR.

Gate: adversarial fixtures for each addition; HTTP contract tests; a security review of the
state route, the refresh action, and the byte resources as one PR each.

### M3 — Asset pipeline and entry points

- **Spike first:** Pierre 1.5.2's web components and `@pierre/trees` under a strict CSP
  (shadow-DOM styles, worker and WASM needs), and bundle size with lazily loaded grammars and
  themes. The outcome sets the page CSP and the size budget. Pin `@pierre/trees` to an exact
  version, as `@pierre/diffs` is pinned, because it is still in beta.
- **Build.** `scripts/build/build-web.ts` bundles `web/main.tsx` for browsers with hashed,
  code-split chunks. `build-bin.ts` embeds the output; `build-npm.ts` ships it in `dist/npm`.
  `check:pack` and `check:prebuilt-pack` fail when assets are absent. Nothing loads from a
  network origin.
- **Serving.** The daemon serves the page at `/review/<session>/` and assets under a shared
  hashed path, with a page-specific CSP (`script-src 'self'`, `connect-src 'self'`, no remote
  origins), `no-store` on the document, and immutable caching on hashed assets. The page
  request carries no secret; the client reads the capability from `location.hash`.
- **CLI.** `--web` on every review command runs headless and implies `--watch`; a new
  `--no-watch` flag opts out. `--no-open` prints the URL without launching a browser. `hunk session open [selector]` opens a browser on a running session,
  and the terminal UI gains a host-only "Open in browser" command. The opener preserves URL
  fragments on macOS, Linux, and Windows.

Gate: CLI contract tests in `test/cli/`; offline-asset check; a served-page test asserting
headers and that the document contains no capability.

### M4 — Read-only client

- **Transport.** `apiClient` (capability header, range reads assembled by
  `ReviewChunkAssembler` with a Web Crypto digest), a `fetch`-stream event reader built on
  `reviewEventProtocol`, one reconnect scheduler (C5), one epoch queue for superseded loads
  (C3), and a mirror ordered by `classifyReviewPublication`.
- **Layout.** Toolbar (title, file count, totals, layout toggle, theme picker); resizable files
  sidebar with tree and flat modes, change-kind icons, and note and stat badges; one
  top-to-bottom stream of every visible file with sticky file headers; collapsed gaps that
  expand from source resources; inline note cards; the terminal's empty, binary, too-large,
  and rename-only placeholders.
- **Shared helpers.** Move the sidebar stat formatter, file labels, and tree projection out of
  `ui/lib/files.ts` (which imports `node:path/posix`) into a platform-neutral module both
  renderers import (E1). STML renders to DOM from the shared tag roles.
- **Theme.** `AppTheme` tokens become CSS variables; Pierre receives the matching Shiki theme.
  The picker lists the built-in catalog and stores its override per browser.
- **Keyboard.** The host's resolved keymap mapped onto DOM events, with browser-reserved chords
  masked. Hunk, file, and annotated navigation run locally through `planReviewSelectionMove`.
- **Live reload.** A generation swap keeps the reader's position by file key and content
  identity, and marks files that changed.
- **Windowing.** Files mount as they approach the viewport; heights are reserved from the
  document's `splitLineCount` and `unifiedLineCount` so the scrollbar is stable.

Gate: the browser projection joins the conformance harness (note placement, gap addressing,
reveal targets, default note targets); web boundary and node-free closure gates active;
Playwright end-to-end tests against a real daemon and headless host.

### M5 — Interactive client (first release)

- Create, edit, reply to, and delete notes; toggle agent notes; set the filter.
- Mouse line-range comments: drag in the gutter to select a range and open a composer.
  Several local drafts may be open at once and survive a tab reload.
- Command palette (`Cmd/Ctrl+K`) and help overlay rendered from the shared catalog, with
  host-only commands omitted. Go-to-file (`Cmd/Ctrl+P`) over the sidebar projection.
- Refresh button and key, through the `review/refresh` action.
- Failures shown from `reviewErrorCatalog`.
- Deep links: reintroduce the semantic address grammar (G3) beside this first consumer, for
  file, hunk, line, and note fragments and back/forward history.

Gate: command-parity test (palette and help list exactly the catalog's browser-reachable
commands); accessibility pass with axe; `minor` changeset, docs page, and a terminal plus
browser smoke run.

### M6 — Web-only tools

Independent PRs, in suggested order:

1. **Viewed files and progress.** A checkbox per file header and sidebar row, a progress
   indicator in the toolbar, a "hide viewed" toggle, and automatic un-viewing on content change.
2. **Notes panel.** A docked list of all notes with source and file filters, threads, and
   click-to-jump, built on `selectNavigableStoredReviewNotes`.
3. **Stats overview.** Totals, per-directory rollups, change-kind breakdown, a size pill, a
   tests-versus-source split, and notes per file. Rollups are a shared selector in
   `core/review`, so `hunk session` can report the same numbers.
4. **Rich previews.** Image diffs (side by side, swipe, onion skin) from byte resources, and a
   rendered-Markdown toggle.
5. **Minimap.** A scroll-track overview marking changed regions, notes, and viewed files, drawn
   from document geometry rather than the DOM.

## Deferred

- Guide view and diff-aware find. Native browser find only sees mounted files; until find
  lands, the filter and go-to-file are the cross-file search.
- History, status, and document-browsing surfaces.
- Remote access beyond loopback.
- Host-only and extension commands other than refresh, including edit-in-`$EDITOR`.
- Scope selectors (per-turn or per-commit diffs) and iteration compare.
- Persisting viewed state across runs.

## Risks

- **M1 touches the terminal's core loop.** `useTerminalReview.ts` is about 2,000 lines and
  `AppHost` owns commit ordering that tests depend on. Mitigation: extract in three
  behavior-neutral PRs, treat any needed PTY test edit as a behavior change, and land M1
  before any client code.
- **Pierre on the web is unproven here.** Hunk uses Pierre's metadata and highlighter, not its
  DOM renderer, and `@pierre/trees` is a beta whose API may change between releases. The M3
  spike runs before the client design is fixed, and both packages are pinned.
- **Binary size.** Embedding a client plus grammars and themes grows every install. Measure in
  the spike and set a budget; lazy chunks keep first paint small but not the download.
- **Two selection models.** Agents reading `hunk session context` see the terminal's position
  in a terminal session and the browser's in a headless one. The rule is stated in M1 and
  needs a line in the generated review skill.
- **Large reviews.** The state snapshot is bounded by the 4 MiB envelope, and a catalog may
  list 15,000 resources. Windowing and bounded-parallel resource loads are required from M4.

## Verification

- Every PR: `bun run typecheck`, `bun run test`, `bun run deps:check`, and the review
  conformance suite.
- M1: `bun run test:integration` and `bun run test:tty-smoke`, unchanged.
- M2–M3: `bun run test:session-broker-node`, `test/session/`, `test/cli/`, and
  `wire.snapshot.test.ts` after the version bump.
- M4 onward: Playwright end-to-end tests under a new `test/web/` directory (Unix and Windows),
  plus one manual run of a real diff in a terminal and a browser side by side.
