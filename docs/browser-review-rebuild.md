# Browser review rebuild plan

The synchronized browser-review feature (originally prototyped in one large branch) lands as a
stack of small, independently reviewable PRs. Its Hunk-owned capability, resource, and semantic
protocol remains separate from the generic per-application daemon contract in
[`session-broker-sdk.md`](session-broker-sdk.md). Each phase has a hard gate and stands on the
previous one. The seam contract — shared primitives stay renderer-free and platform-neutral —
is enforced by `scripts/source-boundaries.test.ts`, whose debt lists may only shrink.

Each phase lists the audit findings it repays (`browser-review-seam-audit.md`, ids A1–G5). A
finding whose duplicate sites span phases is checked off when its **last** site converts; until
then it stays open with the converted sites noted. Phases 0–5 change no user-reachable
behavior (the browser client has no entry point until Phase 6) and ship empty changesets;
Phase 6 carries the `minor` changeset announcing the feature.

## Phase 0 — seam contract and guardrails (this doc)

- Boundary gates for `packages/hunk/src/core/review/` (the shared review model), `packages/hunk/src/session/reviewProtocol.ts`
  (the wire schema), and `packages/hunk/src/web/` (the browser client). The gates tolerate absent trees, so
  they land ahead of the code they constrain.
- A shrink-only debt map for the Node-only primitives the prototype's model files still carry;
  each entry must be repaid with a platform-neutral implementation before a browser bundle may
  import that file.
- The existing architecture boundaries stay at full strength. The prototype relocated bundled
  VCS providers into `packages/hunk/src/core/vcs/` and weakened this suite to compensate; that relocation must
  not ride along with any rebuild phase — extraction PRs land against the restored gates.

## Phase 1 — review model + terminal adoption (three PRs)

1. **Review store**: `state / actions / reducer / store / intents / selectors` in
   `packages/hunk/src/core/review/`, with `useReviewController` / `App` / `AppHost` refactored onto it in the
   same PR. Behavior-neutral; existing PTY integration tests must pass untouched.
2. **Review document projection + diff geometry**: `document / identity / sourceIdentity /
anchors / contentManifest / notes / expansion / reconcile / jsonStream` plus the geometry
   primitives, adopted by the terminal — including switching the terminal's collapsed-gap math
   to `reviewGapAddress` (A1) and note-anchor ranges to full per-side extents (A3). The
   conformance harness (`test/review-conformance/`) and its first adversarial fixtures land
   here; add the directory to the CLAUDE.md test-directory list in the same PR.
3. **Navigation intents + command catalog**: `selection/move` / `selection/select-file` and
   the shared navigation/reveal/note selectors; the agent runtime's `navigateSession` deleted
   in favor of the shared walk; the command catalog split with semantic commands lowered to
   intents; the semantic address grammar.

Repays: A1–A10 (PR 2); B1–B9, B11, F1–F3, G3 core grammar (PR 3); D2 core and terminal sites.
B-findings with browser sites stay open until Phase 5 consumes the selectors.
Gate: ladder rungs 1–4 — tombstones appended for every deleted copy, terminal planner
registered in the conformance harness, adversarial fixtures landed per repaid finding, and the
existing PTY suite passing untouched.

## Phase 2 — producer runtime

`packages/hunk/src/app/reviewSessionRuntime.ts`: generations, snapshot serving, resource materialization,
serving the existing `hunk session` surface only. Resource read failures map to distinct error
codes (integrity failures are never collapsed into `unknown-resource`).

Repays: D1 and D4 producer/snapshot sites (helpers land in core beside the model; remaining
sites convert in Phase 3); D5 producer sites.
Gate: producer registered in the conformance harness; existing `test/session/` suite passing
untouched (rung 4).

## Phase 3 — wire protocol + broker mirror

`reviewProtocol.ts`, broker `wire.ts` validation, broker review mirror, `reviewResourceCache`
(bounded in-flight budget). Patch reconstruction for `hunk session review --include-patch` uses
bounded-parallel loads from day one. Valuable without any web UI: agents get chunked,
digest-verified, memory-bounded resource access. Optional extension-delegated review identity rides
in bounded registration metadata and projects into list, context, and review snapshots; it never
enters `ReviewDocumentV1` or creates a remote reload/provider capability. The wire vocabulary is derived from
`ReviewIntent` (B12) and carries `expandedLineProof` (B10) and actor identity (G2) from its
first version so the browser never needs a schema break.

Repays: B10, B12, G2 wire fields; C1/C2 producer and broker sites (their browser sites close
in Phase 5); D1/D3/D5 broker sites.
Gate: broker suites join the conformance harness (wire round-trip + mirror against the shared
fixtures, including the C1 ordering fixtures); `reviewResources.integration.test.ts` with the
parallel-load test; vocabulary derivation checks active (rung 5).

## Phase 4 — HTTP surface, no client (landed)

`browserReviewServer` + capability auth + SSE, loopback-only, tested with plain `fetch`.
Four routes per live session, mounted inside the existing daemon rather than on a port per
terminal: the current publication (position plus resource catalog), bounded digest-verified
resource reads through the existing mirror and cache, an SSE stream, and action submission
parsed by `reviewProtocol.ts` and forwarded to the existing `apply_review_action` path —
which this gives its first production caller. Range handling covers zero-length resources.
The SSE event contract lives in a shared `reviewEventProtocol` module from day one (C4), and
the user-facing error catalog is created beside the stabilized error codes (G4).

Authorization is a capability the _session_ mints, publishing only its SHA-256 to the
daemon; it rides in the URL fragment and is presented in a request header, so it reaches no
log, path, or query string, and a cross-origin page cannot attach it the way it could a
cookie — which is why there is no CSRF machinery and no CORS header anywhere on the surface.
That replaces the prototype's cookie exchange and, with it, the renewal problem: a
capability lives as long as the session, so a review outlives any TTL by construction. The
cost is that `EventSource` cannot carry a header, so the Phase 5 client reads the stream
with `fetch` — which is also what makes C5's single reconnect scheduler reachable.

Repays: C4 server side; G4 catalog creation.
Gate: HTTP-contract tests against the shared event-protocol module; security review focused on
this PR alone.

## Phase 5 — browser client (two PRs)

1. **Read-only mirror**: `apiClient` / `mirror` / `pierreDocument` / review stream rendering a
   snapshot with Pierre — built on the shared geometry/selector/ordering primitives from day
   one (no `sideRange`, no local acceptance rules, no bare `split("\n")`). No actions, no note
   editing.
2. **Interactivity**: action dispatch through the broker, selection sync (G2 policy decided
   before this PR), note editing, watch/reload generation swaps, browser key bindings and the
   command palette rendered from the shared catalog.

Repays: A11, C3, C5, E1, G1; the browser sites of A/B/C/D findings left open in earlier
phases; F browser bindings; G3/G4 browser adoption. E2 and the G2 selection policy must be
decided (not necessarily built) before PR 2.
Gate: browser projection joins the conformance harness — the same fixtures every other
consumer runs, closing the renderer-parity loop (note placement, gap addressing, reveal
targets, default note targets); web boundary gates and the browser-closure node-free gate
active; command-parity check (both clients render command surfaces from the shared catalog).

## Phase 6 — entry points and packaging

- `--web` / `--no-open` / `hunk session open` / `--tailscale` CLI wiring. The review URL is
  always recoverable from the terminal, and the opener preserves URL fragments on every
  platform (no `rundll32`). Deep-link fragments use the shared address grammar (G3), never
  ad-hoc strings.
- Offline browser assets are generated at build/release time or diff-checked by a script gate,
  not hand-maintained compiled output.

Repays: G3 fragment adoption (closes G3).
Gate: CLI contract tests, offline-asset check, real terminal + browser smoke run, and a final
audit-doc sweep — every A–F finding checked off or explicitly re-scoped, G5 remaining as a
placement rule.

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
- **Navigation semantics** (`core/review` intents/selectors, Phase 1 PR 3): relative hunk/file
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

The terminal command system (`packages/hunk/src/ui/lib/appCommands.ts`) fuses three separable things per
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

Phasing: the catalog split and semantic lowering land in Phase 1 PR 3, alongside the
navigation intents the semantic commands lower to. Browser key bindings and the command
palette land with Phase 5, gated by the shared catalog so the two clients cannot drift on what
a command means. Brokered host-command invocation is explicitly out of scope until the
allowlist design exists.

## Per-phase seam verification

Import gates prove code _may_ use a primitive, not that it _does_ — a consumer can silently
re-derive. Every phase therefore passes the same five-rung ladder, and each rung is mechanical:

1. **Boundary gates** (every phase, exists today): `scripts/source-boundaries.test.ts` —
   import containment, shrink-only debt lists, and the extracted-duplicate tombstone list.
   Repaying an audit finding means deleting the duplicate copies **and appending their paths to
   the tombstone list in the same PR**; a resurrected path fails CI forever after.
2. **Conformance harness** (built in Phase 1 PR 2, grows every phase — not deferred to Phase 5):
   one golden fixture corpus under `test/review-conformance/`, with every consumer registering
   a suite against the _same_ fixtures as it lands — terminal render planning (Phase 1),
   producer projection (Phase 2), broker mirror and wire round-trip (Phase 3), HTTP surface
   (Phase 4), browser projection (Phase 5). A phase's gate is that all previously registered
   suites still pass plus its own joins.
3. **Adversarial fixtures from the audit**: every audit finding that documented a divergence
   contributes the fixture its old copy got wrong — pure-insertion hunks and zero-count sides
   (A1/A2), hunks with leading context (A3), CRLF and no-trailing-newline sources (A4),
   fallback-owner and expanded-gap notes (D3/B8), non-contiguous state revisions and replayed
   events (C1), oversized note bodies at the per-field/whole-note boundary (D1). Expected
   values in these fixtures are written **by hand from the semantics**, not generated by
   calling the primitive — a generated expectation would follow a bug instead of catching it.
   Repaying a finding requires landing its fixture; the finding's checkbox in the audit doc
   points at the fixture file.
4. **Behavior invariance**: adoption phases must not change what users see — Phase 1 passes
   the existing PTY integration suite untouched, Phases 2–3 the existing `test/session/`
   suite. A needed test edit in these phases is a red flag reviewed as a behavior change, not
   a test update.
5. **Vocabulary derivation checks** (Phase 3 on): a test asserts the wire action vocabulary
   equals the intent vocabulary minus a named exclusion list (so a new intent that should be
   wire-reachable cannot be silently forgotten — the B12 failure mode), and that coupled
   constants are imports, not re-declared literals.

Residual risk — a consumer re-implementing a primitive _identically_ passes fixtures until the
copies drift. Where that risk is highest (geometry, ordering rules), spot-check with a seam
probe: temporarily patch the core primitive to return a sentinel in a scratch build and confirm
each consumer's conformance suite fails. Not CI machinery — a release-prep check for Phases 1,
3, and 5.

Process rule tying it together: every extraction PR names the audit finding ids it repays, and
"repaid" is defined mechanically as (a) duplicate copies deleted, (b) tombstones appended,
(c) the finding's adversarial fixture landed, (d) the consumer registered in the conformance
harness. A finding without all four stays open in the audit doc.
