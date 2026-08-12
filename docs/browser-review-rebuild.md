# Browser review rebuild plan

The synchronized browser-review feature (originally prototyped in one large branch) lands as a
stack of small, independently reviewable PRs. Each phase has a hard gate and stands on the
previous one. The seam contract — shared primitives stay renderer-free and platform-neutral —
is enforced by `scripts/source-boundaries.test.ts`, whose debt lists may only shrink.

## Phase 0 — seam contract and guardrails (this doc)

- Boundary gates for `src/core/review/` (the shared review model), `src/session/reviewProtocol.ts`
  (the wire schema), and `src/web/` (the browser client). The gates tolerate absent trees, so
  they land ahead of the code they constrain.
- A shrink-only debt map for the Node-only primitives the prototype's model files still carry;
  each entry must be repaid with a platform-neutral implementation before a browser bundle may
  import that file.
- The existing architecture boundaries stay at full strength. The prototype relocated bundled
  VCS providers into `src/core/vcs/` and weakened this suite to compensate; that relocation must
  not ride along with any rebuild phase — extraction PRs land against the restored gates.

## Phase 1 — review model + terminal adoption (two PRs)

1. **Review store**: `state / actions / reducer / store / intents / selectors` in
   `src/core/review/`, with `useReviewController` / `App` / `AppHost` refactored onto it in the
   same PR. Behavior-neutral; existing PTY integration tests must pass untouched.
2. **Review document projection**: `document / identity / sourceIdentity / anchors /
contentManifest / notes / expansion / reconcile / jsonStream`, adopted by the terminal.
   Note-anchor ranges use full per-side extents (`*Count`), not changed-line counts (`*Lines`),
   fixed once here in shared code.

Gate: `bun test`, `bun run test:integration`, seam boundary tests.

## Phase 2 — producer runtime

`src/app/reviewSessionRuntime.ts`: generations, snapshot serving, resource materialization,
serving the existing `hunk session` surface only. Resource read failures map to distinct error
codes (integrity failures are never collapsed into `unknown-resource`).

Gate: `test/session/` integration suite.

## Phase 3 — wire protocol + broker mirror

`reviewProtocol.ts`, broker `wire.ts` validation, broker review mirror, `reviewResourceCache`
(bounded in-flight budget). Patch reconstruction for `hunk session review --include-patch` uses
bounded-parallel loads from day one. Valuable without any web UI: agents get chunked,
digest-verified, memory-bounded resource access.

Gate: broker suites and `reviewResources.integration.test.ts`, including the parallel-load test.

## Phase 4 — HTTP surface, no client

`browserReviewServer` + capability auth + SSE, loopback-only, tested with plain `fetch`.
Auth sessions renew (a review must be able to outlive the initial cookie TTL) and Range
handling covers zero-length resources.

Gate: HTTP-contract tests; security review focused on this PR alone.

## Phase 5 — browser client (two PRs)

1. **Read-only mirror**: `apiClient` / `mirror` / `pierreDocument` / review stream rendering a
   snapshot with Pierre. No actions, no note editing.
2. **Interactivity**: action dispatch through the broker, selection sync, note editing,
   watch/reload generation swaps.

Gate: browser test suite, split to match the two cuts; web seam boundary test; renderer parity
tests — shared fixtures drive the terminal planner and the browser projection and must agree on
note placement, gap addressing, reveal targets, and default note targets.

## Phase 6 — entry points and packaging

- `--web` / `--no-open` / `hunk session open` / `--tailscale` CLI wiring. The review URL is
  always recoverable from the terminal, and the opener preserves URL fragments on every
  platform (no `rundll32`).
- Offline browser assets are generated at build/release time or diff-checked by a script gate,
  not hand-maintained compiled output.

Gate: CLI contract tests, offline-asset check, real terminal + browser smoke run.

## Seam inventory (prototype audit)

A file-level audit of the prototype found roughly thirty duplicated derivations across the
terminal, browser, agent runtime, and broker — the seam is wider than the review model and wire
schema. Each rebuild phase lands the primitives below and deletes the per-consumer copies it
replaces. This section is the summary; the per-finding work-list with sites and observed
divergences is `browser-review-seam-audit.md`, and extraction PRs check findings off there:

- **Diff geometry** (`core/review`, Phase 1 PR 2): per-side hunk ranges (`reviewHunkRange` —
  the prototype has four implementations, one wrong), gap addressing (`reviewGapAddress` — the
  terminal's own copy is off by one against core's), trailing-gap existence, expansion side,
  hunk rebasing for isolated rendering, normalized source-line splitting (browser skips the
  CRLF normalization core digests depend on), per-file split/unified line totals carried on
  `ReviewFileV1` instead of recomputed, empty-diff reason, default hunk note target, and STML
  tag roles so both renderers share one tag vocabulary.
- **Navigation semantics** (`core/review` intents/selectors, Phase 1): relative hunk/file
  navigation with an explicit wrap policy (`selection/move` — the prototype implements the walk
  three times: terminal, agent runtime, and the browser was set to become a third), file-jump
  (`selection/select-file`), selection normalization and fallback, reveal-target resolution,
  active-note selection, notes-by-hunk grouping (owner-index based, not range containment), one
  filter matcher shared by stream and tree, one note-visibility predicate, and one
  viewport-anchor policy. The wire vocabulary is derived from `ReviewIntent` instead of
  hand-restated, and gains the `expandedLineProof` field the browser needs for expanded-line
  selection parity.
- **Ordering and transfer** (`core/review` + protocol, Phases 3–4): one generation/state-
  revision acceptance state machine (the prototype has five with differing rules), one chunk
  assembly/verification helper (four copies, two inside one file), one epoch/supersede queue,
  one reconnect scheduler, and an SSE event-contract module so server and client derive frame
  names, envelopes, and byte bounds from the same constants.
- **Validation single-sourcing** (`reviewProtocol` + `core/review`, Phases 2–4): note byte
  bounds measured one way everywhere (the prototype's per-field vs whole-note split lets an
  oversized note poison the entire snapshot), one empty-body policy, one note-anchor ownership
  calculator (producer, broker, and browser each re-derive it, the broker's copy dropping the
  fallback branch), an order-independent canonical-file/manifest consistency check, shared
  digest validators and exact-key helpers, and no re-declared wire constants.
- **Presentation helpers** (Phase 5): file stat badges and change-kind decorations, plus the
  browser importing shared language registration for side effects.

Deliberately renderer-specific — do not unify: terminal row building, cell measurement, and row
windowing; browser IntersectionObserver windowing and DOM reveal mechanics; STML layout; platform
hashing (`node:crypto` vs Web Crypto); theme palettes, pending a product decision on whether the
browser mirrors the terminal theme.

## Commands and keyboard shortcuts in the browser

The terminal command system (`src/ui/lib/appCommands.ts`) fuses three separable things per
command: identity (id, title, chords), binding (terminal `KeyEvent` matching), and effect
(closures over live App state). Making commands work in the browser means splitting them, not
transporting them:

- **Catalog as shared data**: id, title, category, default chords, and a declared resolution
  locus move to a renderer-neutral catalog. Menus (`appMenus.ts`), the help dialog, and a
  browser command palette all render from the same catalog, and user `[keybindings]` config
  applies to the catalog rather than to one renderer.
- **Three resolution loci, declared per command**:
  - _Semantic_ — lowers to a `ReviewIntent` and resolves at the producer, with changes
    broadcast to every attached client (hunk/file navigation, annotated navigation, start
    note, toggle gap expansion, toggle agent notes, filter). The browser fires these through
    the existing apply-action wire path — no new wire surface, and the agent runtime's
    `hunk session` commands become a third consumer of the same lowering.
  - _Client-local_ — view state that is deliberately per-client (scrolling, paging, line
    alignment, layout mode, wrap, line numbers, sidebar, menu bar, theme selector, help).
    Each client implements its own handler; identity and chords stay shared so help and
    palettes agree.
  - _Host-only_ — quit, source refresh, edit-in-`$EDITOR`, agent-skill helpers, and all
    extension commands. Not invocable from the browser by default: extension commands execute
    host-side with dialog access, so browser invocation is remote code execution and needs an
    explicit per-command allowlist in the registration capability list. Deferred beyond the
    initial rebuild.
- **Keymap**: chords keep the shared string vocabulary (`keymap.ts`); each client maps chords
  to its own event type and masks what its platform reserves (e.g. browser `Cmd+W`).

Phasing: the catalog split and semantic lowering belong to Phase 1 — converting terminal `run`
closures into intent dispatches is the same refactor that moves the terminal onto the shared
store. Browser key bindings and the command palette land with Phase 5, gated by the shared
catalog so the two clients cannot drift on what a command means. Brokered host-command
invocation is explicitly out of scope until the allowlist design exists.
