# Browser review seam audit — prototype duplication findings

Companion to `browser-review-rebuild.md`. This is the per-finding work-list behind the plan's
seam inventory: every duplicated derivation found in the prototype, the sites on each side, the
observed or reachable divergence, and the shared primitive that replaces it. File/line
references are against the prototype branch (`feat/browser-review` at merge commit `9bb0ad0`)
and will drift as that branch changes; treat them as locators, not anchors. Each extraction PR
should delete the copies its primitive replaces and check off the finding here.

## Run boundary — after Phase 5 PR 1

Phases 0–4 and Phase 5's first PR have landed: the seam contract and its gates, the shared
review model with the terminal on it, the producer runtime, the wire protocol with the
daemon's review mirror and resource path, the HTTP surface, and now a read-only browser
mirror that reads a publication over that surface and renders it with Pierre. What remains
open, and where the plan puts it:

- **Phase 5 PR 1 answered the question the last run left open, and the answer is no.** A
  publication is a position plus a resource catalog, and the catalog's three resource
  kinds — canonical file, patch, source — carry the review's _content_ and nothing about
  its _semantic position_. Selection, filter, expansion, and notes live in the producer's
  `ReviewState`, and no resource contains them, so a client cannot mirror them by reading
  harder. A read-only client therefore renders content only, and the browser sites of every
  note-shaped finding (B7, B8, D1's composers, D3, A9's STML parsing) cannot be repaid
  until PR 2 puts a review's semantic state on the wire. That is a scope fact, not an
  oversight: the alternative — a client deriving a selection of its own — is exactly the
  duplication this seam exists to prevent.
- **C3 is closed by there being one machine, not by unifying two.** The finding paired the
  prototype's browser snapshot recovery with a runtime reload queue that never landed in
  the rebuild. The mirror's supersede rule (`src/web/reviewMirror.ts`) is now the only one
  in the repo: a load belongs to the generation that started it and checks that it is still
  current before publishing anything, so a newer generation makes an older load's result
  unwanted rather than something to cancel and unwind. Nothing to extract; a primitive with
  one consumer would be the thing the seam rules warn about.
- **No replay buffer, still.** The surface answers any `Last-Event-ID` with a fresh
  publication rather than retained frames, and the client is built for exactly that: a
  publication is a complete resynchronization, so a reconnect needs no history.
- **Browser sites still open after PR 1** — B3–B6 (file-jump, selection fallback, filter
  matching, reveal-target resolution) all need a selection to exist, which is PR 2; B10's
  client, D1's composers, and D3's `pierreNoteAnchor` need note composition; A9's parser
  relocation is still the prerequisite for rendering notes at all.
- **E2** — the theme decision is still open, and PR 1 deliberately did not make it: the
  browser renders in Pierre's own palette and imports nothing from `src/ui/themes`. Due
  before PR 2.
- **F browser bindings** — F1–F3's browser halves (palette, keymap resolution onto DOM
  events). F4 stays a scope boundary, not work.
- **G1 part (b), G2 policy** — the classification is done and the client consumes it; how a
  client _persists_ its own overrides is PR 2's, alongside the multi-client selection and
  authorship policy G2 is waiting on.
- **G3 adoption** — the grammar now has its first consumer (browser anchors); deep-link
  _navigation_ and opener fragments close it in PR 2 and Phase 6.
- **G5** — a placement rule for undo, if undo is ever built. Not work.

One residual earlier runs created rather than inherited: remote note _composition_ has no
draft-body intent yet (recorded under B12).

PR 1 also closed a gap in the Phase 4 surface that only a client could find. A published
catalog describes resources the producer has not measured yet — measuring one means
producing its bytes — so a reader had nothing to verify a read against. Every resource
response now carries the whole resource's size and digest in headers declared beside the
routes (`reviewContentMeasurementHeaders`), and the daemon keeps the digest its own
assembly verified against rather than rehashing per request.

## A. Diff geometry

- **A1. Collapsed-gap line ranges — 3 implementations, terminal off by one.** Terminal
  `src/ui/diff/pierre.ts` (`leadingCollapsedRanges`/`trailingCollapsedRanges`, ~:456-480) vs
  core `src/core/review/expansion.ts` (`reviewGapAddress`); web already consumes core's gap
  objects. For a pure-insertion hunk the terminal's leading range is off by one against core's,
  and the trailing math diverges for zero-count sides; a note created on a terminal-expanded
  line can be rejected on reload because `intents.ts` validates against `reviewGapAddress`.
  Fix: terminal calls `reviewGapAddress`; delete its local math.
  _Repaid (Phase 1 PR 2)_: `reviewLeadingGap`/`reviewGapAddress` in `core/review/expansion.ts`;
  `pierre.ts` copies deleted; fixtures `pure-insertion-hunk` and `pure-deletion-hunk` in
  `test/review-conformance/geometryFixtures.ts`; core and terminal render planning both registered.
  Residual (found in review): when the anchor side has zero rows and untouched content
  precedes the hunk, the parser's `collapsedBefore` undercounts the leading gap by one line
  — the leading-side sibling of A2's residual, recorded on `reviewLeadingGap` and pinned
  (as the residual, explicitly) by the `pure-deletion-hunk` fixture; both residuals stage
  together as one disclosed behavior-change commit.
- **A2. Trailing-context existence — 3 formulations.** `pierre.ts` `trailingCollapsedLines`,
  producer `src/session/app/registration.ts` (~:131-139, boolean `hasTrailingContext`), core
  `expansion.ts`. The browser can offer a "Trailing context" button whose expansion core then
  rejects (`gap-not-found`). Fix: one `reviewTrailingGap(file)` in core.
  _Repaid (Phase 1 PR 2)_: `reviewTrailingGap` in `core/review/expansion.ts`;
  `trailingCollapsedLines`/`trailingCollapsedRanges` deleted from `pierre.ts`. Residual, recorded
  in that function: a last hunk with a zero-count side leaves the two line-array tails one apart,
  so no trailing gap is offered even though the file has one. Every consumer now agrees on hiding
  it; correcting the count changes terminal output and is staged separately.
- **A3. Per-side hunk range — 4 implementations, one wrong.** `core/liveComments.ts`
  `hunkLineRange`, `core/review/anchors.ts` `reviewHunkRange` (correct), web
  `pierreDocument.ts` `sideRange` (uses changed-line counts `deletionLines`/`additionLines` as
  span lengths — wrong for hunks with leading context, misplacing notes in the browser), and
  `ReviewStream.tsx` re-filtering against manifest ranges. Fix: `reviewHunkRange` everywhere;
  collapse `hunkLineRange` into it.
  _Repaid (Phase 1 PR 2)_: `reviewHunkRange`/`reviewHunkRanges` in `core/review/geometry.ts`;
  `hunkLineRange` deleted and all six terminal/session sites converted; fixture
  `hunk-with-leading-context`.
  _Closed (Phase 5 PR 1, browser site)_: the browser's render model reads its per-hunk
  extents from `reviewHunkRanges`; there is no `sideRange`, and the `browser review
projection` consumer answers `hunk-with-leading-context` beside the terminal.
- **A4. Source-line splitting for expanded context — 3 implementations, browser skips
  normalization.** Terminal `expandCollapsedRows.ts` `sliceLines` and core `anchors.ts`
  `normalizedReviewSourceLines` agree (CRLF-normalize, strip one trailing newline); web
  `ReviewStream.tsx` does a bare `split("\n")` — `\r` glyphs, phantom EOF line, and context
  digests that can mismatch on reload. (`sourceBackedHighlight.ts` `splitSourceLines` is a
  legitimate fourth variant — Pierre's highlighter needs retained newlines; comment it.) Fix:
  export and adopt `normalizedReviewSourceLines`.
  _Repaid (Phase 1 PR 2)_: `normalizedReviewSourceLines` in `core/review/geometry.ts`;
  `expandCollapsedRows.ts` `sliceLines` deleted; `splitSourceLines` carries the comment saying why
  it is legitimately different; fixtures `crlf-source` and `source-without-trailing-newline`.
  _Closed (Phase 5 PR 1, browser site)_: `reviewExpandedGapRows` splits the source it read
  with the shared splitter, and the `browser review projection` consumer answers both
  fixtures — the bare `split("\n")` the finding names never existed in this client.
- **A5. Expansion side policy `deleted ? "old" : "new"` — 3 copies.** Core `intents.ts`
  (authoritative), terminal `diffSectionRowPlan.ts` (recomputed instead of reading `gap.side`),
  web `pierreDocument.ts` fallback ordering. Fix: thread `gap.side`; export
  `reviewExpansionSide(file)`.
  _Repaid (Phase 1 PR 2)_: `reviewExpansionSide` in `core/review/expansion.ts`; both terminal
  recomputations (`diffSectionRowPlan.ts`, `useReviewController.ts`) deleted.
  _Closed (Phase 5 PR 1, browser site)_: the render model carries `expansionSide` from the
  same function, and the client reads the source resource for that side rather than deciding
  by fallback ordering.
- **A6. Hunk content-index rebasing — 2 copies, opposite `isPartial` conclusions.** Web
  `pierreDocument.ts` `isolatePierreHunk` vs terminal `sourceBackedHighlight.ts` (~:108-199).
  Fix: one `rebaseReviewHunk(hunk, origins)` in core.
  _Repaid (Phase 1 PR 2, terminal site)_: `rebaseReviewHunk` in `core/review/geometry.ts`, adopted
  by `sourceBackedHighlight.ts`. It returns the per-side end indices so a caller can slice or
  validate without re-walking.
  _Closed (Phase 5 PR 1, browser site)_: `isolateReviewHunk` in `src/web/pierreDocument.ts` is
  the shared walk plus two slices taken with the indices it reports, so the browser cannot
  disagree with the terminal about where a hunk's lines end. The stream renders one Pierre
  view per hunk — which is what makes a collapsed-region strip land between the right two
  hunks — and `pierreDocument.test.ts` pins that each isolated render carries exactly its own
  hunk's lines and stays partial.
- **A7. File split/unified line totals — web guesses.** `pierreDocument.ts` reconstructs
  `splitLineCount`/`unifiedLineCount` by reducing over hunks; terminal reads Pierre's
  authoritative values. Mis-sizes browser virtualization when the parser counts rows outside
  hunk spans. Fix: carry both on `ReviewFileV1`.
  _Repaid (Phase 1 PR 2, model side)_: `splitLineCount`/`unifiedLineCount` carried on
  `ReviewFileV1` by `core/review/document.ts`.
  _Closed (Phase 5 PR 1, browser site)_: `buildReviewFileRenderModel` reads both off the file.
  `pierreDocument.test.ts` asserts they differ from the sum over hunks on a real parse, which
  is the mis-sizing the prototype's reduction produced.
- **A8. Empty-diff explanation — 3 variants with different precedence.** Terminal
  `renderRows.tsx` `diffMessage` (rename-pure first), web `ReviewStream.tsx` (binary first),
  `staticDiffPager.ts` (extra cases). Same file can explain itself differently per client.
  Fix: `reviewEmptyDiffReason(file)` in core.
  _Repaid (Phase 1 PR 2)_: `reviewEmptyDiffReason` in `core/review/document.ts` with one canonical
  precedence — what the change _is_ outranks how it is stored (`rename-only` -> `binary` ->
  `too-large` -> `new-file` -> `deleted-file` -> `no-hunks`), the review stream's existing order.
  `renderRows.tsx` and `staticDiffPager.ts` keep their own wording and share the reason; fixture
  `binary-rename-with-no-rows`. The static pager's own order put storage first, so a renamed
  binary or oversized rename now reports as a rename there too.
  _Closed (Phase 5 PR 1, browser site)_: the browser keeps its own wording too and shares the
  reason, so the binary-first precedence the prototype used is gone; the projection consumer
  answers `binary-rename-with-no-rows`.
- **A9. STML tag vocabulary — parse shared, tag semantics forked.** Terminal
  `ui/lib/stml/layout.ts` handles the full vocabulary; web `ReviewNote.tsx` handles a subset
  (everything else flattens to `<span>`) and accepts a `<tag>` alias the terminal lacks. Fix:
  `stmlTagRole(tag)` in `core/review/stml.ts`; both renderers switch on roles.
  _Repaid (Phase 1 PR 2, terminal site)_: `core/review/stml.ts` owns the tag-to-role table;
  `ui/lib/stml/layout.ts` switches on roles and `parse.ts` derives its void/raw-text tags from
  them. The parser itself stays in `ui/lib/stml` for now — it sanitizes through
  `lib/terminalText`, which core may not import — so relocating it is Phase 5 work, before the
  browser can parse notes.
- **A10. Default line target for a hunk note — 2 divergent rules.** Terminal
  `core/liveComments.ts` `firstCommentTargetForHunk` (first added line, else first deleted);
  web `App.tsx` (hunk's first line — usually context). Same action anchors to different lines
  per client. Fix: `reviewDefaultHunkLineTarget(hunk)` in core, used by both (and by reveal).
  _Repaid (Phase 1 PR 2)_: `reviewDefaultHunkLineTarget` in `core/review/geometry.ts`;
  `firstCommentTargetForHunk` deleted and both terminal callers converted; every geometry fixture
  pins the target, `pure-deletion-hunk` and `hunk-with-leading-context` adversarially.
  _Closed (Phase 5 PR 1, browser site)_: the render model carries the shared target per hunk
  and the projection consumer answers every fixture with it, so the prototype's "hunk's first
  line" rule cannot come back. Nothing renders a note there yet — a publication carries none
  — which is why the target is model rather than pixels until PR 2.
- **A11. Language registration side effect missing in browser.** `core/fileLanguage.ts`
  registers `.mts`/`.cts`; the web bundle never imports it, so Pierre's own inference runs
  unregistered for files without an explicit `language`. Fix: side-effect import in
  `src/web/main.tsx` (or fold registration into the shared model).
  _Closed (Phase 5 PR 1)_: `src/web/main.tsx` imports `../core/fileLanguage` for its side
  effect before anything renders. The boundary gate refused the import until
  `BROWSER_SAFE_CORE_MODULES` named the module and the reason, which is deliberately a list
  rather than a directory — `src/core` also holds config resolution and file I/O, which a
  browser has no business reaching.

Renderer-specific, do not unify: terminal row construction and measured-cell windowing
(`rowWindowing.ts`, `diffSectionGeometry.ts`) vs browser IntersectionObserver windowing and
height estimation; move-kind painting (browser lacks the Pierre input — a feature gap, not a
duplication); hunk header text (browser delegates to Pierre separators); platform hashing.

## B. Navigation and selection

- **B1. Hunk navigation across the stream — 3 implementations.** Terminal
  `useReviewController.ts` + `ui/lib/hunks.ts` (cursors, nearest-cursor, multi-step carry);
  agent runtime `reviewSessionRuntime.ts` `navigateSession` (separate walk whose terminal
  parity is asserted only by a comment, and which lacks the terminal's multi-step carry rule);
  browser (none yet — would be the third). Annotated sets are also built from different inputs
  (terminal `DiffFile` model vs `intersectingHunkIndices`). Fix: `selection/move` intent
  (`scope: hunk|file|annotated-hunk|annotated-file`, delta, wrap policy) planned over shared
  selectors; delete `ui/lib/hunks.ts` and the runtime walk.
  _Repaid (Phase 1 PR 3, core and terminal sites)_: `planReviewSelectionMove` in
  `core/review/navigation.ts`, reached through the `selection/move` intent. `ui/lib/hunks.ts` is
  deleted and tombstoned, and the session runtime's separate walk is gone — comment navigation
  (`--next-comment` / `--prev-comment`) now plans the same intent the keyboard does, so the
  multi-step carry rule it lacked applies there too. Fixture `annotated-hunk-multi-step-carry`
  in `test/review-conformance/navigationFixtures.ts`; the planner is registered as a navigation
  consumer. Residual: which hunks count as annotated is still derived from the terminal's merged
  diff-file model (`buildReviewAnnotationIndex`) and handed to the planner as a caller-owned
  fact, because the semantic document does not carry notes yet — one derivation now, consumed by
  both the keyboard and the session.
- **B2. Wrap vs clamp policy split.** `moveToFile` clamps; `moveToAnnotatedFile` wraps
  (`ui/lib/reviewState.ts`). Encode per-scope wrap policy in the `selection/move` intent.
  _Repaid (Phase 1 PR 3)_: `REVIEW_SELECTION_WRAP_POLICY` names the policy per scope —
  hunk/file/annotated-hunk clamp, annotated-file wraps — and `findNextAnnotatedFile` is deleted.
  The asymmetry is today's terminal behavior kept deliberately, including two quirks now stated
  rather than implied: a clamping hunk move at an edge re-selects and re-reveals the same hunk
  while a file move at an edge publishes nothing at all, and annotated-file navigation from a
  file with no notes enters the ring at its start (so the first forward step lands on the ring's
  _second_ entry). Fixture `scope-wrap-and-clamp`.
- **B3. File-jump semantics — hard-coded identically in both clients.** "Hunk 0 + file-top
  reveal" in terminal `App.tsx`/`useReviewController.ts` and web `App.tsx`; the terminal-only
  forward-cross-file alignment rule has no web counterpart. Fix: `selection/select-file`
  intent owning the rule.
  _Repaid (Phase 1 PR 3, core and terminal sites)_: `selection/select-file` owns "first hunk"
  (`REVIEW_FILE_JUMP_HUNK_INDEX`) with `REVIEW_FILE_JUMP_REVEAL` as its default reveal, and the
  forward-cross-file alignment rule moved into the hunk-move planner, where the crossing is
  known. The terminal's `selectFile` lowers to the intent and no longer takes a hunk index.
  Fixture `scope-wrap-and-clamp` pins both reveals. The browser's copy lands in Phase 5.
- **B4. Selection fallback after reload/filter — 2 divergent answers.** Terminal
  `resolveSelectedFile` returns undefined (renders "no file"); web `validSelection` and
  `treeSource.reset` silently fall back to `files[0]`. Core permits `fileKey: null`. Fix:
  `selectNormalizedSelection`/`selectFallbackFileKey` selectors; delete both client fallbacks.
  _Repaid (Phase 1 PR 3, core and terminal sites)_: both selectors live in
  `core/review/selectors.ts`, and `resolveSelectedFile` is deleted. Recorded difference from this
  finding's description: the terminal in this repo did _not_ render "no file" for a selection the
  filter hides — it kept rendering the selected file, and fell back only when the file was gone
  from the document. That behavior is authoritative and is what the selector now states, so
  `fileKey: null` is reached exactly when nothing is visible at all. Fixtures
  `selection-outliving-its-file` and `selection-with-nothing-visible`. The browser's
  `validSelection`/`treeSource.reset` fallbacks close in Phase 5.
- **B5. Filter matching — 3 matchers.** Core `reviewFileMatchesFilter` (path, previousPath,
  agentSummary), terminal `filterReviewFiles` (normalized paths), web tree search
  (canonicalPath only) — browser sidebar and stream can disagree on the same query. Also
  live-per-keystroke (terminal) vs apply-on-Enter (web, which clobbers in-flight typing on
  snapshot). Fix: one matcher; one committed-vs-live decision.
  _Repaid (Phase 1 PR 3, core and terminal sites)_: `reviewFileMatchesFilter` in
  `core/review/selectors.ts` is the only matcher, and `filterReviewFiles` is deleted. The
  terminal's behavior won on both points of difference: paths are normalized before matching
  (core's matcher did not), and the three fields are joined before the substring test, so a query
  may span the boundary between them. Residual: the committed-vs-live decision is still open —
  the terminal matches live per keystroke, and planning reads the immediate filter while
  rendering reads a one-render-deferred copy of it. The browser's tree search closes in Phase 5.
- **B6. Reveal-target derivation — web re-derives, wrongly.** Web `App.tsx` recomputes the
  hunk target line (`newRange ? "new" : "old"`), duplicating core `canonicalLineForHunk` which
  prefers by side counts and requires a backed line — pure-deletion hunks scroll the wrong side
  in the browser. Fix: `selectRevealTarget(state)` selector; clients only resolve DOM/rows.
  _Repaid (Phase 1 PR 3, core site)_: `reviewCanonicalHunkLine` in `core/review/geometry.ts`
  (preferred side first, backed sides only), behind `selectRevealTarget`. Fixture
  `pure-deletion-reveal-target` pins the case the prototype browser got wrong, and pins that a
  hunk's position is its first row while a note about the whole hunk hangs from its first change.
  The terminal's reveal is row geometry it measures itself and stays renderer-local.
  _Partly repaid (Phase 5 PR 1, browser geometry)_: the browser's render model carries each
  hunk's reveal target from `reviewCanonicalHunkLine`, so the `newRange ? "new" : "old"`
  recomputation the finding names does not exist here. Reading `selectRevealTarget` — the
  selector over review _state_ — needs a selection to reveal, so the client half of that
  closes with PR 2.
- **B7. "Jump to note" target — terminal geometry decides, web ignores.** The
  active-note choice lives in `DiffPane.tsx` row scanning; web never reads
  `reveal.scrollToNote`. Fix: `selectActiveRevealNoteId(state)` in core.
  _Repaid (Phase 1 PR 3, core site)_: `selectActiveRevealNoteId` names the policy — an active
  draft in the selected hunk first, else the note anchored earliest in it, arrival order breaking
  ties — which is what `DiffPane`'s row scan resolves geometrically today. The terminal site
  stays open: it looks the answer up by measured row bounds, and swapping that for the selector
  is a rendering change rather than a semantic one. Browser adoption is Phase 5.
- **B8. Notes-by-hunk grouping — web re-filters by range containment.** `ReviewStream.tsx`
  drops annotations whose anchor came from core's fallback path or expanded context even after
  `pierreDocument` accepted them — notes silently disappear in the browser. Fix: group by
  `ownerHunkIndex` via a shared `selectNotesByHunk`.
  _Repaid (Phase 1 PR 3, core site)_: `selectNotesByHunk` groups by `reviewNoteOwnerHunkIndex`,
  reading the ownership `resolveReviewNoteAnchor` decided instead of re-testing containment. The
  terminal site stays open deliberately: `DiffPane` groups by range overlap and therefore renders
  a note under _every_ hunk it overlaps, so converting it changes what a reviewer sees and
  belongs in a behavior-changing PR, not this one.
- **B9. Note-visibility policy — two core predicates for one rule.**
  `selectors.ts` `reviewNoteVisibleByPolicy` (web path) vs `notes.ts` `alwaysShowReviewNote`
  (terminal path). Collapse to one predicate over `{source}`.
  _Repaid (Phase 1 PR 3)_: one `reviewNoteVisibleByPolicy` over `{source}` in
  `core/review/state.ts`, beside the other stored-note policies; `alwaysShowReviewNote` is
  deleted, and `DiffPane` calls the predicate over the normalized source.
- **B10. Selected-line semantics — browser structurally weaker.** Terminal maps rendered rows
  to semantic side/line with `expandedLineProof` and separates "anchor" from "reveal"; web
  sends raw lines with `reveal` forced on every click, and the wire `selection/set-line` /
  `notes/create-user` actions have no `expandedLineProof` field at all — browser clicks inside
  expanded regions are rejected or mis-sided. Fix: add the proof to the wire schema; make
  reveal an explicit caller decision in both clients.
  _Repaid (Phase 3, wire and producer sites)_: `ReviewExpandedLineClaim` in
  `core/review/expansion.ts` states what a caller claims — the gap, the side, the line, and the
  identity of the source it expanded — and `resolveReviewExpandedLine` is the one thing that
  decides whether the claim holds. The wire carries it as `expandedLineProof` on the two
  actions that can name a line (`notes/start-draft`'s target, and `notes/create-user`'s
  precondition on the draft it is saving), refusing evidence that accompanies no line, and
  `src/session/app/reviewCommands.ts` checks it before planning. Where the resulting note hangs
  is deliberately _not_ decided there: it goes through `reviewLineAnchor`'s fallback owner
  exactly as a terminal note does, which `reviewCommands.test.ts` pins by asserting an empty
  intersection set and the declared owner. Fixtures `start-draft-on-an-expanded-line`,
  `create-user-note-at-an-expanded-line`, and `start-draft-with-a-proof-about-nothing` in
  `test/review-conformance/wireFixtures.ts`. Reveal is already an explicit caller decision on
  every intent that carries one; the browser half of both closes in Phase 5.
- **B11. Viewport-driven selection — opposite policies.** Terminal publishes
  nearest-hunk-to-center into shared state; web keeps IntersectionObserver results local. With
  both clients attached, terminal scrolling rewrites shared selection under the browser. Fix:
  one core policy (e.g. `selection/anchor` intent that never bumps reveal tokens).
  _Repaid (Phase 1 PR 3, core and terminal sites)_: `REVIEW_VIEWPORT_ANCHOR_REVEAL` in
  `core/review/state.ts`, and the `selection/anchor` intent that carries it. The terminal's
  viewport-centered hunk selection and its line-cursor anchoring both publish through it, and the
  local `preserveViewport` selection option is deleted. The policy is stated, but the
  multi-client question it exists for — whether an anchor should be shared at all — is G2,
  decided before Phase 5 PR 2.
- **B12. Wire vocabulary hand-restates `ReviewIntent` — 3 places.** `HunkReviewActionV1`
  union, capability list in `registration.ts`, validation list in `wire.ts`, remapped
  field-by-field in `reviewSessionRuntime.ts`; forgotten fields/actions are silently
  unreachable from the browser. Fix: derive the wire type and both lists from one
  `HUNK_REVIEW_ACTION_TYPES` source; validate-and-narrow rather than restate.
  _Repaid (Phase 3)_: `REVIEW_INTENT_TYPES` in `core/review/intents.ts` is the vocabulary,
  made total in both directions by type assertions — a member added to `ReviewIntent` and not
  listed fails to typecheck, and a listed name that is not an intent fails too.
  `HUNK_REVIEW_ACTION_TYPES` _is_ that list, and nothing is withheld: a semantic intent
  resolves at the producer and is broadcast to every attached surface, so every one of them
  belongs to every surface. Withholding one would mean subtracting it by name, with the reason
  it is not shareable. The wire _type_ is derived
  the same way — `HunkReviewActionV1` is `ReviewIntent` with the two wire-only fields added to
  the members that need them — and `toReviewIntent` strips them again, so an action is
  validated and narrowed rather than restated. The action-type-to-parser table is keyed by the
  vocabulary, so a wire-reachable intent without a parser does not compile.
  `scripts/review-vocabulary.test.ts` is the ladder's rung 5: it asserts the equality, that
  every exclusion names a real intent once, and that every type in the vocabulary really
  reaches a parser. Round-trip fixtures for all twelve actions live in
  `test/review-conformance/wireFixtures.ts`, registered as the `review wire protocol` consumer.
  Residual: remote note _composition_ is not expressible yet. The vocabulary has no
  draft-body intent, so a remote client can open a draft and save it but not type into it;
  adding one is Phase 5's note-editing work, and until then the gap is a named absence rather
  than a forgotten action.

Renderer-specific, do not unify: terminal line-cursor measurement/reconciliation; browser
requestAnimationFrame/MutationObserver reveal mechanics; tree presentation details (duplicate
path suffixes, expansion retention, git-status badges).

## C. Transport and lifecycle

- **C1. Generation/state-revision acceptance — 5 implementations, 3 policies.** Web
  `mirror.ts` (retired-generation memory; requires contiguous `+1` revisions — a contract the
  server does not guarantee, since initial snapshots and `Last-Event-ID` replay can skip),
  broker `state.ts` (accepts equal revisions for width-only refreshes), producer
  `reviewSessionRuntime.ts` (equality required except selection actions), `wire.ts` parse-time
  triple-equality, plus a fifth copy in web `App.tsx` compensating for the first being
  stricter than the broker. Fix: `core/review/generationOrder.ts` exporting the invariant and
  `classifySnapshot`/`classifyState` → `accepted|stale|gap`, consumed by all five sites.
  _Repaid (Phase 2, producer site)_: `core/review/generationOrder.ts` states the invariant
  once — a generation carries a producer id and a sequence that advances by exactly one, and
  revisions strictly increase but need not be contiguous — and `classifyReviewPublication`
  answers `accepted | stale | gap`. `assertReviewPublicationAdvance` is the producer's own
  side of it, checked before any generation is swapped in. Two decisions worth stating:
  revision skips are legal (the prototype client's contiguous `+1` rule is the bug, not the
  contract), and a republication carrying no new semantic position — a renderer width changed
  and nothing about the review did — classifies as a replay, so the broker's "accept equal
  revisions for width-only refreshes" case becomes a publication-key decision at the producer
  rather than a looser comparison. Fixtures live in
  `test/review-conformance/orderingFixtures.ts` and cover both the classification and the
  transitions a real producer emits. Broker and browser sites close in Phases 3 and 5.
  _Repaid (Phase 3, broker site)_: the daemon's `ReviewMirror`
  (`src/session/broker/reviewMirror.ts`) holds one publication per session and orders every
  arriving one with a single `classifyReviewPublication` call — `accepted` advances the
  revision, `gap` replaces the generation and retires everything derived from the old one,
  `stale` is ignored. It has no comparison of its own, so the prototype's "accept equal
  revisions for width-only refreshes" case does not exist here: a republication carrying no
  new position is a replay, exactly as the contract says. The one non-ordering rule it does
  apply is stated as such — a later generation is adoptable only together with the catalog
  describing it, because a mirror holding a position whose resources it cannot name would
  advertise reads nobody can serve. `src/session/app/reviewCommands.ts` makes the same one
  call for an action's `expectedStateRevision`, so "has the review moved past what this
  caller decided from" is the same question as "is this publication ahead". The mirror is
  registered against the Phase 2 fixtures as the `broker review mirror` ordering consumer,
  which is what proves it has no rules of its own.
  _Closed (Phase 5 PR 1, browser site)_: `src/web/reviewMirror.ts` makes one
  `classifyReviewPublication` call and acts on the verdict — `accepted` advances the
  position and reads nothing (a generation's document is immutable, so there is nothing to
  re-read), `gap` resyncs, `stale` is ignored. The prototype's contiguous `+1` revision
  rule is gone with it, and `browser review mirror` is registered as an ordering consumer
  whose verdict is _inferred from what the mirror did_ rather than reported by it: a client
  with a comparison of its own disagrees with the reference on the C1 fixtures. Five
  implementations with three policies are now one.
- **C2. Chunk assembly + verification — 4 copies, 2 in one file.** Web `apiClient.ts` range
  loop; broker `state.ts` materializing and pre-sized loops (which already disagree on
  progress/eof rules); SSE reassembly in `mirror.ts`. Three in-flight dedupe key formats;
  digest case normalized on a different operand in each. Fix:
  `core/review/resourceAssembly.ts` (`ChunkAssembler` with expected size/digest, bounded
  progress, verified finalize) plus one keyed single-flight helper; HTTP Range/abort, broker
  reservations, and concurrency tuning stay at the edges.
  _Repaid (Phase 2, producer site)_: `core/review/resources.ts` owns resource addressing, the
  chunk bound both ends validate against, and the failure vocabulary;
  `src/app/review/resourceStore.ts` produces and serves the bytes. Single flight is
  structural rather than a cache bolted on — a read reaches the underlying reader only
  through the in-flight map — and bulk loads run under an explicit concurrency limit instead
  of an unbounded `Promise.all`, which is the pair of defects the original review found.
  Digest comparison normalizes both operands (`reviewDigestsEqual`). The reader half — chunk
  reassembly against an expected size and digest — lands with the broker in Phase 3 and
  consumes the same module.
  _Repaid (Phase 3, broker site)_: `core/review/resourceAssembly.ts` is the reader half —
  one `ReviewChunkAssembler` that holds a stream to the size and digest it declares, requires
  each chunk to start where the last ended, treats a chunk that neither advances nor ends as
  a failure, accepts a zero-length resource as one empty end-of-stream chunk, and verifies
  the assembled bytes against the digest with a `ReviewDigestFn` the caller injects. The
  broker's load loop (`src/session/broker/state.ts`) does nothing but ask for the next window
  and decode it; there is one loop, where the prototype had two near-verbatim copies inside
  this file that already disagreed about progress and end-of-stream. Bounding is
  `reviewResourceCache.ts`: an LRU with a daemon-wide byte budget plus a reservation taken
  before any bytes are requested, so assemblies in flight are bounded too — and an unmeasured
  resource reserves one chunk and is resized to what the writer declares rather than
  reserving its kind's ceiling, which is what let a handful of ordinary patches serialize the
  parallel loads. Single flight is one map keyed by session, generation, and resource id;
  concurrent callers await the same assembly. `src/session/broker/reviewResources.integration.test.ts`
  drives the whole path with only the socket replaced.
  _Closed (Phase 5 PR 1, browser site)_: `ReviewApiClient.readResource` asks for windows and
  hands each one to a `ReviewChunkAssembler`; it has no loop of its own beyond "ask for the
  next offset", and the four copies with three in-flight key formats are now one class.
  Two transport facts stay at the edge, as the finding says they should: the first window
  asks for no `Range` at all — a zero-length resource has no satisfiable range, so asking
  for one would refuse a resource that is merely empty — and end-of-stream is the window
  that reaches the size the response states, since HTTP has no eof marker. Bulk loads run
  under the shared `REVIEW_RESOURCE_LOAD_CONCURRENCY` rather than an unbounded
  `Promise.all`. The measurement to verify against is the response's own
  (`HUNK_REVIEW_CONTENT_SIZE_HEADER` / `HUNK_REVIEW_CONTENT_DIGEST_HEADER`), because a
  published catalog's descriptors are unmeasured until the producer materializes them.
- **C3. Epoch/supersede/trailing-retry — 2 parallel machines.** Runtime reload queue
  (`reloadEpochSequence`/`supersededReloads`) vs web snapshot recovery
  (`recoveryEpoch`/trailing while-loop), plus three unrelated anti-spin timing constants. Fix:
  one epoch-queue primitive; keep DOM/React wiring local.
  _Closed (Phase 5 PR 1), by there being one machine_: the runtime reload queue never landed
  in the rebuild — the producer publishes generations and `assertReviewPublicationAdvance`
  checks them — so the only supersede rule in the repo is the mirror's, and it is a
  generation comparison rather than a counter: a load records the generation it is for and
  publishes only if that is still the current one. There is no trailing while-loop and no
  anti-spin constant, because a superseded load is abandoned rather than retried.
  Extracting a primitive for a single consumer is the thing this seam's rules warn about.
- **C4. SSE event contract defined on both ends.** Frame names (`${type}-begin/-chunk/-end`),
  begin/end envelopes, and the event-id grammar are built in `browserReviewServer.ts` and
  re-declared/regex-parsed in `mirror.ts`/`apiClient.ts`; client bounds (12 MiB / 1024 chunks)
  are unlinked from server bounds and only coincidentally compatible. Fix:
  `src/session/reviewEventProtocol.ts` owning names, envelopes, id grammar, and bounds derived
  from `MAX_BROWSER_REVIEW_SNAPSHOT_BYTES`.
  _Repaid (Phase 4, server side)_: `src/session/reviewEventProtocol.ts` owns the event
  vocabulary, the frame names and their phases, the begin/chunk/end envelopes and their
  parsers, the event-id grammar, and every bound — `MAX_REVIEW_EVENT_PAYLOAD_BYTES` is the
  protocol's envelope bound, `REVIEW_EVENT_CHUNK_BYTES` is the shared resource chunk size,
  and `MAX_REVIEW_EVENT_CHUNKS` is the quotient, so a sender asking for smaller windows is
  clamped to the ceiling a reader is allowed to hold rather than emitting frames the reader
  will refuse. `browserReviewServer.ts` imports all of it and declares none of it; the
  browser client imports the same module unchanged in Phase 5, which
  `scripts/source-boundaries.test.ts` keeps possible by gating the module's transitive
  closure platform-free. Two decisions differ from the prototype deliberately: a chunked
  payload is framed and verified as the byte stream it is, so reading it is the shared
  `ReviewChunkAssembler` rather than a fourth reassembly loop (C2's rule applied here); and
  only the frame that _completes_ an event carries an `id`, so a `Last-Event-ID` can never
  name a position inside a half-delivered payload. Fixtures
  `publication-exactly-one-window` and `publication-one-byte-over-a-window` in
  `test/review-conformance/eventFixtures.ts` pin the boundary the two ends must agree on,
  and both the protocol and the real HTTP surface are registered as event consumers.
  _Closed (Phase 5 PR 1, client side)_: `ReviewApiClient.streamEvents` reads the stream with
  `fetch` and parses it with `parseReviewEventFrameName`, `parseReviewEventFrame`,
  `parseReviewEventBegin`/`Chunk`/`End`, and `ReviewEventAssembler` — it declares no frame
  name, no envelope, no id pattern, and no bound. `browser review client reader` is
  registered as an event consumer against the same fixtures the surface answers, with the
  response body teed so the frames can be counted without asking the client to report its
  own framing. Sender and reader now answer one corpus, which is what the finding was for.
- **C5. Reconnect/backoff — 4 schedulers, 1 verbatim duplicate.** `apiClient.ts` (exp/4 s),
  web `App.tsx` (exp/4 s + anti-spin), `brokerClient.ts` (fixed 3 s — re-implementing the
  scheduler of the connection it already configures), `session-broker/connection.ts`. Fix: one
  `createReconnectScheduler` in `@hunk/session-broker-core`; EventSource's built-in reconnect
  interplay stays client-side.
  _Closed (Phase 5 PR 1)_: `createReconnectScheduler` in `@hunk/session-broker-core` owns
  "one pending attempt, a delay that may grow, a stop that cannot be restarted, a timer that
  does not hold the process open". `SessionBrokerConnection` and `HunkSessionBrokerClient`
  both dropped their copies with their timing unchanged (the default factor is 1, so a fixed
  three seconds stays a fixed three seconds), and the browser mirror asks the same scheduler
  for backoff with jitter — jitter because one daemon restart drops every open tab at once.
  There is no `EventSource` reconnect to interleave with, which is the other half of why the
  client reads the stream with `fetch`.

## D. Notes and validation

- **D1. Note byte bounds measured in two units.** Wire checks `body` and `markup` separately
  against `MAX_REVIEW_NOTE_BYTES`; broker/producer check whole-note JSON — so a note that
  passes action validation can poison the entire snapshot with a capacity error. Neither
  client pre-checks size, and the server's action-body cap is smaller than the largest
  "valid" note. Fix: one `reviewNoteWithinSizeLimit` used by wire, broker, producer, and both
  composers.
  _Repaid (Phase 2, core and producer sites)_: `core/review/noteSize.ts` measures the whole
  note in the unit a transport pays — its serialized bytes, through the platform-free
  `utf8ByteLength` — and `MAX_REVIEW_NOTE_BYTES` sits beside it. Fixtures
  `test/review-conformance/noteSize.ts` pin the boundary the two prototype rules disagreed
  at, including a note whose summary, rationale, and markup each fit while the note itself is
  three times the bound. Wire and composer sites adopt it in Phases 3 and 5.
  _Repaid (Phase 3, wire site)_: `isTransportableReviewNote` in `src/session/reviewProtocol.ts`
  is `reviewNoteWithinSizeLimit` and nothing else — the wire has no per-field check any more, and
  declares no second bound. The protocol module is registered as a consumer of the note-size
  corpus, so `every-field-fits-but-the-note-does-not` — the note whose summary, rationale, and
  markup each pass a per-field check while the note is triple the bound — is now refused at the
  wire rather than admitted and then failing at the publisher. Both composer sites are Phase 5.
- **D2. Empty-body policy — 5 declarations.** Core intents (throws), terminal (cancels
  draft — a deliberate UX difference worth keeping explicit), web in three places. Fix: one
  `isBlankReviewNoteBody` predicate.
  _Repaid (Phase 1 PR 2, core and terminal sites)_: the predicate lives in
  `core/review/intents.ts`, and `test/review-conformance/noteBodies.ts` pins the boundary cases
  against both the predicate and the draft-persistence plan they drive.
- **D3. Note-anchor ownership — 4 implementations.** Core `resolveReviewNoteAnchor`
  (authoritative, with fallback-owner support), `notes.ts` sibling over Pierre geometry,
  broker `wire.ts` re-derivation that omits the fallback branch (a legal expanded-gap note can
  get a whole registration rejected), web `pierreNoteAnchor` without the count clamp. Fix: one
  owner/intersection calculator parameterized over a range accessor.
  _Repaid (Phase 3, broker and wire sites)_: by deletion rather than by extraction — the
  daemon has no anchor calculator at all. The broker mirrors a position and a resource
  catalog, forwards an action, and never sees a note's ranges; ownership is decided once, by
  `resolveReviewNoteAnchor` at the producer, reached through the intent. That is what makes
  the prototype's failure impossible rather than merely fixed: its broker copy re-derived
  intersections, omitted the fallback branch, and rejected a legal expanded-gap note — and
  with it the whole registration. The case is pinned from the wire end in
  `src/session/app/reviewCommands.test.ts`: a note created remotely on an expanded-gap line
  ends up with an empty intersection set and the fallback owner the caller declared, which is
  exactly the shape the dropped branch produced. Web `pierreNoteAnchor` closes in Phase 5.
- **D4. Canonical-file ↔ manifest consistency — 3 checks, 3 field lists.** Producer
  `registration.ts` (authoritative ~17 fields), web `parseCanonicalReviewFile` (12, and
  compares `flags`/`sourceResourceIds` via key-order-sensitive `JSON.stringify` — lazily
  inserted source ids can spuriously error a file), broker legacy check (10). Nobody compares
  canonical hunk _content_ to manifest hunks. Fix: one order-independent
  `assertCanonicalFileMatchesManifest` in core; producer self-check reuses it.
  (`contentManifest.ts` is legitimately different — a parity-test snapshot, not a validator.)
  _Repaid (Phase 2, core and producer sites)_: `core/review/canonicalFile.ts` carries no field
  list of its own — it projects the candidate file into a content manifest entry and compares
  that by value at every level, so the list cannot drift from what the model says a file is,
  key order never participates, and hunk content is checked alongside the geometry derived
  from it. The manifest gained the content that requires (patch text, hunk blocks, source
  identity) and stays a snapshot rather than becoming the validator. The producer self-checks
  with it before serving any canonical file, and the conformance harness runs that check over
  every fixture.
  _Closed (Phase 5 PR 1, browser site)_: the browser has no field list and no second
  consistency check. It recomputes the file's own content identity with
  `reviewFileContentIdentityOf` — the same function projection uses, so producer and reader
  cannot compute it differently — and refuses a file that does not hash to what it declares
  or that arrives under another key. A field list cannot drift from the model when there is
  no field list. Projection now hashes the file it built rather than a parallel description
  of it, which is what made the reader's half expressible at all.
- **D5. Validator/constant hygiene.** `isReviewSha256Digest` exists but is bypassed by five
  inline regexes with case-sensitivity drift; raw `createHash("sha256")` at seven sites
  instead of `reviewDigest`; `hasExactKeys` private while the pattern is inlined ~10×;
  action-envelope parsing duplicated between `reviewProtocol.ts` and `browserReviewServer.ts`;
  wire constants re-declared as literals (client range size vs server response cap, snapshot
  bounds, filter length cap) and re-typed in tests. Fix: export the validators/helpers from
  `reviewProtocol`/`brokerWireParsers`; import constants everywhere, and derive coupled bounds
  from each other. Also name the intentionally stricter `resolution === "active"` filter
  (`isActiveStoredReviewNote`) beside `isRenderableStoredReviewNote`, and comment why
  `parseReviewState` notes intentionally skip manifest-geometry matching.
  _Repaid (Phase 2, core and producer sites)_: `core/review/validation.ts` owns the digest
  vocabulary and the exact-key check the producer validates with and the wire protocol will.
  `isReviewSha256Digest` accepts only the canonical lowercase form — the case-insensitive
  variant is what let a writer and a reader disagree — with `normalizeReviewDigest` for values
  arriving from outside and `reviewDigestsEqual` normalizing _both_ operands. Hashing itself is
  an injected `ReviewDigestFn` rather than inline `createHash` calls; the producer supplies
  Node's at the edge (`src/lib/reviewDigest.ts`), which is also what repaid the shared model's
  last node-debt entry. Resource bounds are constants in `core/review/resources.ts` that the
  producer imports rather than restates. Wire constants, the action-envelope parser, and the
  two note-filter namings are Phase 3.
  _Repaid (Phase 3, wire and broker sites)_: the resource-read request moved into
  `core/review/resources.ts`, so the producer and the wire parse one shape with one parser
  instead of the producer owning it and the wire copying it; `REVIEW_RESOURCE_LOAD_CONCURRENCY`
  moved beside the other resource bounds for the same reason, now that both the producer and
  the daemon run bulk loads. The failure vocabulary is composed rather than restated
  (`HunkReviewFailureCodeV1` = resource + request + intent-planning codes), the navigable
  scopes are read out of `REVIEW_SELECTION_WRAP_POLICY` rather than listed again, the
  catalog's file bound is derived from its own resource count instead of duplicating the
  registration's file limit, and every digest check is `isReviewSha256Digest`. The one
  coupling the protocol cannot express as an import is the transport frame size — importing
  the broker package would cost the module its browser safety — so
  `scripts/review-vocabulary.test.ts` asserts it instead, alongside a check that no session
  module re-declares a name the review model exports and that no module writes its own
  64-character digest pattern. Naming `isActiveStoredReviewNote` beside
  `isRenderableStoredReviewNote` and commenting `parseReviewState` are browser-tier work and
  stay open with the rest of D5's browser sites.

## E. Presentation helpers

- **E1. File stat badges.** Terminal `ui/lib/files.ts` `formatSidebarStat` (zero-hiding,
  truncation marker) vs web inline `+${additions} −${deletions}` in `treeSource.ts`. One
  shared formatter.
  _Closed (Phase 5 PR 1)_: `reviewFileStatBadges` in `core/review/presentation.ts` decides
  the text, and states the two policies rather than leaving them implicit — a zero count is
  hidden, and truncation is marked once, on the additions badge, because one marker per file
  is enough to say both numbers are lower bounds. The sidebar's private `formatSidebarStat`
  is deleted and tombstoned; the browser's file list and file headers call the same
  function, so churn cannot read one way in a terminal and another in a browser.
- **E2. Theme.** Web hardcodes two standalone palettes disconnected from `src/ui/themes` and
  the `AppTheme` mapping; whether the browser mirrors the terminal theme is an open product
  decision — decide before Phase 5, don't unify by default.
  _Still open after Phase 5 PR 1, deliberately_: the read-only client renders in Pierre's own
  palette and imports nothing from `src/ui/themes`, so no default has been set by accident.
  `theme` is classified as a per-client option in `REVIEW_VIEW_OPTION_LOCUS`, which is the
  part that was mechanical; whether a browser should adopt the terminal's chosen theme is
  still the product decision, due before PR 2.

## F. Commands and keybindings (preemptive — the prototype browser had none)

The prototype browser client shipped no command system, so these are not observed duplications
like A–E; they are the copies the browser _would_ grow the moment shortcuts are added, recorded
here so the extraction happens before the duplication exists. Design detail in
`browser-review-rebuild.md` § "Commands and keyboard shortcuts in the browser".

- **F1. Command catalog fused with terminal binding and effects.** `src/ui/lib/appCommands.ts`
  couples identity (id, title, chords), binding (terminal `KeyEvent` matchers), and effect
  (closures over live App state) in one table; menus (`ui/lib/appMenus.ts`) and the help
  dialog render from it, so a browser palette or help screen would have to restate the list.
  Fix: extract a renderer-neutral catalog (id, title, category, default chords, resolution
  locus — semantic / client-local / host-only); terminal keeps matchers and handlers, browser
  adds its own, both render menus/help/palette from the catalog.
  _Repaid (Phase 1 PR 3)_: `src/core/commandCatalog.ts` carries id, title, category, default
  chords, resolution locus, extension visibility, and menu-closing behavior for all 44 built-ins.
  `ui/lib/appCommands.ts` builds its dispatch table from it — the handler map is keyed by
  `AppCommandId`, so a catalogued command with no terminal handler fails to typecheck — and
  menus and help keep reading identity through that table. Parity is asserted in
  `appCommands.test.ts` ("command catalog parity"): the table is exactly the catalog in catalog
  order, and no menu item or help row names a command the catalog does not declare. Placement
  note: the catalog sits outside `core/review`, which stays review semantics only, so Phase 5
  must add it to the web boundary gate's allowed import targets.
- **F2. Semantic command effects are closures instead of intent dispatches.** The ~15
  review-semantic commands (hunk/file/annotated navigation, start note, toggle gap, toggle
  agent notes, filter) run as App closures; a browser implementation would re-derive each
  behavior — the exact drift class of B1/B3/B6. Fix: lower semantic commands to
  `ReviewIntent`s (the Phase 1 store refactor is the same work); the browser fires them
  through the existing apply-action path, and the agent runtime's `hunk session` surface
  becomes a third consumer of the same lowering.
  _Repaid (Phase 1 PR 3, core and terminal sites)_: semantic entries declare their effect as data
  (`AppCommandReviewEffect`), and `lowerAppCommandToReviewIntent` is the one constructor turning
  a command plus a repeat count into a `ReviewIntent`. The terminal's navigation handlers read
  the scope and direction from that same declaration rather than restating them. Two semantic
  commands have no intent to lower to yet — starting a note needs caller-owned draft identity,
  and gap expansion is the Phase 2 `expansion/toggle` intent — and are listed by name in
  `SEMANTIC_COMMANDS_WITHOUT_REVIEW_EFFECT`, so the gap is a decision rather than an oversight.
  _Closed (Phase 2)_: both landed. `notes/start-draft` takes caller-owned draft identity and
  an optional client-measured line, falling back to the shared whole-hunk default;
  `expansion/toggle` resolves through `reviewGapAddress` and reports the side, ranges, and
  source identity a caller needs to fill the gap. Which gap the command reaches is
  `selectReviewGapForSelection` in core, replacing the terminal's `selectGapForKeyboardToggle`.
  `SEMANTIC_COMMANDS_WITHOUT_REVIEW_EFFECT` is now empty, and every semantic command lowers to
  an intent a remote client could fire.
  Still open after Phase 5 PR 1: the read-only client fires no commands, so the lowering's
  second consumer is still the PR 2 palette.
  Residual (found in review): `lowerAppCommandToReviewIntent` still has no production caller —
  the terminal's handlers read the catalog's declared scope/direction but build their intents
  inline, so the lowering and the terminal closures can diverge with only
  `commandCatalog.test.ts` noticing half the drift. Closes when the lowering gains its second
  consumer (the Phase 5 palette / wire command path); until then any change to a declared
  review effect must update both sites, and a review-effect parity check is the missing test.
- **F3. Keymap resolution is terminal-owned.** Chords are shared config strings (`keymap.ts`,
  `[keybindings]`), but resolution against defaults and conflict handling lives with the
  terminal table; a browser keymap would duplicate it and drift on user rebinds. Fix: resolve
  user keybindings against the catalog once; each client maps resolved chords to its own event
  type and masks platform-reserved chords (browser `Cmd+W` etc.).
  _Repaid (Phase 1 PR 3, host site)_: `builtinCommandKeyDefaults` reads the catalog, so
  `[keybindings]` resolution, conflict detection against extension commands, and key labels all
  fold user config over catalogued defaults exactly once. Mapping resolved chords onto a client's
  own event type stays per client, which is the part that cannot be shared; the browser's half
  lands in Phase 5.
- **F4. Host-only and extension commands — do not expose, by design.** Quit, source refresh,
  edit-in-`$EDITOR`, agent-skill helpers, and all extension commands execute host-side (with
  dialog access); browser invocation is remote code execution into the terminal session.
  Excluded from the browser until an explicit per-command allowlist exists in the registration
  capability list. This is a scope boundary, not a missing feature.

## G. Other preemptive seams (same class as F)

Further capabilities where the terminal (or multi-client operation itself) has semantics the
prototype browser never grew; recorded so the shared primitive exists before a second
implementation does.

- **G1. View defaults and option classification.** Terminal view options resolve through the
  layered defaults chain (built-ins → user config → repo `.hunk/config.toml` → command
  sections → CLI flags); the prototype browser hardcodes its own defaults (dark theme, layout)
  and has no persistence at all. Two decisions to make once: (a) which options are shared
  review state vs per-client view state — `showAgentNotes` and filter are already shared,
  layout/wrap/theme are per-client — recorded as an explicit classification on the option
  schema, not implied by where code happens to read them; (b) whether the browser receives the
  host's resolved view defaults as its starting point (it should — the host already computed
  them) with per-client overrides persisted client-side. Phase 5.
  _Repaid (Phase 5 PR 1, part (a) and half of (b))_: `REVIEW_VIEW_OPTION_LOCUS` in
  `core/review/viewOptions.ts` classifies every option as `review` or `client` over the
  option schema, with totality as a `Record` over its keys — so an option added without a
  locus fails to typecheck rather than being treated as per-client by whichever surface
  reads it first. The rule behind the table is stated with it: an option is the review's
  when it changes what the review is _about_, and a client's when it changes only how one
  screen draws it. `src/web/viewOptions.ts` resolves the client-locus options only, over the
  host's resolved defaults when the page carries them, and asks the predicate rather than
  assuming — a host default for `showAgentNotes` or the filter is ignored rather than copied
  into per-client state. Part (b)'s remaining half — how a client persists its own
  overrides, and how the host's defaults reach the served page — is PR 2 and Phase 6: they
  belong with the document that serves the page, not with a publication, because a window's
  size is not review state.
- **G2. Actor identity and multi-client selection policy.** Notes carry an optional `author`,
  but wire actions carry no actor/client identity — with a terminal, a browser, and agents
  attached to one session, nothing distinguishes who moved the selection or wrote a note, and
  B11 (viewport-driven selection) already showed the two clients fighting over shared
  selection. Decide the model once: actions carry a client/actor tag; selection is either
  shared-with-follow-mode or per-client-with-optional-follow (product decision); note
  authorship defaults from the actor. Wire fields in Phase 3, policy before Phase 5 PR 2.
  _Repaid (Phase 3, wire fields)_: `HunkReviewActorV1` — an opaque `clientId`, a coarse
  `kind` (`terminal` / `browser` / `agent`), and an optional display name — is required on
  every action and resource-read envelope from the protocol's first version. The finding's
  four parts split cleanly, and only the first is done: (1) actions carry an actor tag, here;
  (2) whether selection is shared-with-follow or per-client-with-follow is a product decision,
  due before Phase 5 PR 2; (3) note authorship defaulting from the actor lands with remote
  note composition in Phase 5; (4) how a client obtains its identity lands with the capability
  the HTTP surface issues in Phase 4. The producer records the tag and applies no policy to
  it, and a client cannot widen what it may do by claiming a kind — so adding a policy later
  changes behavior rather than the schema, which is the whole point of carrying the field now.
  _Amended (Phase 4)_: part (4) does not land with the HTTP surface after all, and the
  reason is worth stating. The capability authorizes _a review_, not _a client_: one link
  may be opened in several tabs, and the surface deliberately cannot tell them apart,
  because a credential that identified a tab would be a credential a tab could be tracked
  by. The actor therefore arrives in the action envelope, opaque and non-authoritative, and
  minting a per-client identity belongs with the client that needs one — Phase 5, beside the
  selection policy that is the only thing which will read it. Parts (2) and (3) are
  unchanged.
- **G3. Semantic addressing / permalinks.** The prototype's URL fragment carries only the
  capability token — there is no grammar for addressing a file/hunk/line/note. Three consumers
  will need one: browser deep links and back/forward history, a terminal "copy link" command,
  and agent surfaces already addressing targets by file/hunk. One serialize/parse address
  grammar over semantic keys (`fileKey`/`hunkIndex`/side/line/noteId — never array indices or
  rendered rows) in `core/review`, used everywhere an address crosses a boundary. Core
  primitive in Phase 1; browser adoption Phase 5; opener fragments Phase 6.
  _Repaid (Phase 1 PR 3, core primitive)_: `core/review/address.ts` serializes and parses the
  four address kinds over percent-encoded semantic identifiers, with round-trip coverage for keys
  carrying separators, percent signs, and non-ASCII characters, and strict rejection of anything
  outside the grammar.
  _First consumer (Phase 5 PR 1)_: the browser stream gives every file and hunk a DOM anchor
  built by `formatReviewAddress`, and the file list links to them — so the addresses a page
  offers are the grammar's rather than strings this client invented. Reading an address back
  (deep-link navigation on load and on `hashchange`) needs a selection to move, which is PR
  2; opener fragments are Phase 6, which is when this finding closes.
- **G4. User-facing error catalog.** The repo already solves this once for agents:
  `src/session/agent/errors.ts` single-sources every message the generated skill quotes, with
  contract tests. The browser has no equivalent — action rejections (`invalid-action`,
  `stale-generation`, resource integrity failures) would surface as ad-hoc strings invented in
  `src/web`, drifting from what the terminal shows for the same failure. One error-code →
  user-message catalog beside the wire protocol, consumed by both clients (and reused by the
  agent surface where codes overlap). Phase 4 (codes stabilize) / Phase 5 (browser consumes).
  _Repaid (Phase 4, catalog creation)_: `src/session/reviewErrorCatalog.ts` gives every code a
  statement and a remedy, in the agent surface's own pattern. Totality is mechanical rather
  than reviewed: the catalog is a `Record` over `HunkReviewClientErrorCodeV1`, itself
  _composed_ — resource plus request plus intent-planning plus the transport's own codes —
  so a code added to any of the four tiers fails to typecheck until it has a message, and
  `reviewErrorCatalog.test.ts` states the vocabulary by hand rather than reading it back out
  of the thing under test. Messages carry no interpolated caller input, so they can be
  rendered anywhere, including where echoing a request back would be wrong; the HTTP surface
  uses a catalog message unless the producer supplied a more specific one. The status map
  lives with the transport (`browserReviewServer.ts`) rather than in the catalog, because a
  client reads codes and an HTTP status is not something to tell a person. The agent surface
  keeps its own wording — its codes are `hunk session` CLI failures rather than these, and
  the two vocabularies do not yet overlap.
  _Closed (Phase 5 PR 1, browser adoption)_: the client invents no wording. Every failure it
  reports is `reviewClientFailure(code)`, whose message is the catalog's unless the surface
  supplied a more specific one, and the page renders that message as-is. The one place the
  client chooses a code rather than reading one is a refusal with no body — an unsatisfiable
  range, which the surface answers as a bare 416 — and that choice is stated where it is
  made.
- **G5. Undo, if it ever arrives.** Note editing today has no undo. If it is added, the
  history/undo semantics belong in the shared reducer (which client undoes what, across
  actors), never in one client's keyboard handler. Recorded as a placement rule, not work.

## Verification hooks

The per-phase verification ladder lives in `browser-review-rebuild.md` § "Per-phase seam
verification". A finding here counts as repaid only when all four hold: duplicate copies
deleted, their paths (for whole files) or banned-symbol entries (for function-level
deletions) appended to the tombstone lists in `scripts/source-boundaries.test.ts`,
the finding's adversarial fixture landed in the conformance harness, and the consumer
registered against that harness.

- The seam boundary tests (`scripts/source-boundaries.test.ts`) keep deleted copies deleted.
- Renderer parity tests (Phase 5 gate) drive shared fixtures through the terminal planner and
  browser projection and assert identical note placement, gap addressing, reveal targets, and
  default note targets — the drift class import gates cannot catch.
- `contentManifest.ts` should additionally cover derived geometry (A1–A4) so parity snapshots
  fail when a renderer re-derives instead of consuming core.
- Command parity (F1–F3): help/menu/palette listings in both clients render from the shared
  catalog in tests, so a command added to one client without catalog registration fails rather
  than forking the vocabulary.
