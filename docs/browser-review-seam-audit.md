# Browser review seam audit — prototype duplication findings

Companion to `browser-review-rebuild.md`. This is the per-finding work-list behind the plan's
seam inventory: every duplicated derivation found in the prototype, the sites on each side, the
observed or reachable divergence, and the shared primitive that replaces it. File/line
references are against the prototype branch (`feat/browser-review` at merge commit `9bb0ad0`)
and will drift as that branch changes; treat them as locators, not anchors. Each extraction PR
should delete the copies its primitive replaces and check off the finding here.

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
  `test/review-conformance/fixtures.ts`; core and terminal render planning both registered.
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
- **A5. Expansion side policy `deleted ? "old" : "new"` — 3 copies.** Core `intents.ts`
  (authoritative), terminal `diffSectionRowPlan.ts` (recomputed instead of reading `gap.side`),
  web `pierreDocument.ts` fallback ordering. Fix: thread `gap.side`; export
  `reviewExpansionSide(file)`.
  _Repaid (Phase 1 PR 2)_: `reviewExpansionSide` in `core/review/expansion.ts`; both terminal
  recomputations (`diffSectionRowPlan.ts`, `useReviewController.ts`) deleted.
- **A6. Hunk content-index rebasing — 2 copies, opposite `isPartial` conclusions.** Web
  `pierreDocument.ts` `isolatePierreHunk` vs terminal `sourceBackedHighlight.ts` (~:108-199).
  Fix: one `rebaseReviewHunk(hunk, origins)` in core.
  _Repaid (Phase 1 PR 2, terminal site)_: `rebaseReviewHunk` in `core/review/geometry.ts`, adopted
  by `sourceBackedHighlight.ts`. It returns the per-side end indices so a caller can slice or
  validate without re-walking; the browser's isolate-one-hunk use lands on it in Phase 5.
- **A7. File split/unified line totals — web guesses.** `pierreDocument.ts` reconstructs
  `splitLineCount`/`unifiedLineCount` by reducing over hunks; terminal reads Pierre's
  authoritative values. Mis-sizes browser virtualization when the parser counts rows outside
  hunk spans. Fix: carry both on `ReviewFileV1`.
  _Repaid (Phase 1 PR 2, model side)_: `splitLineCount`/`unifiedLineCount` carried on
  `ReviewFileV1` by `core/review/document.ts`; the browser consumes them in Phase 5.
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
- **A11. Language registration side effect missing in browser.** `core/fileLanguage.ts`
  registers `.mts`/`.cts`; the web bundle never imports it, so Pierre's own inference runs
  unregistered for files without an explicit `language`. Fix: side-effect import in
  `src/web/main.tsx` (or fold registration into the shared model).

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
  The terminal's reveal is row geometry it measures itself and stays renderer-local; the browser
  consumes the selector in Phase 5.
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
- **C2. Chunk assembly + verification — 4 copies, 2 in one file.** Web `apiClient.ts` range
  loop; broker `state.ts` materializing and pre-sized loops (which already disagree on
  progress/eof rules); SSE reassembly in `mirror.ts`. Three in-flight dedupe key formats;
  digest case normalized on a different operand in each. Fix:
  `core/review/resourceAssembly.ts` (`ChunkAssembler` with expected size/digest, bounded
  progress, verified finalize) plus one keyed single-flight helper; HTTP Range/abort, broker
  reservations, and concurrency tuning stay at the edges.
- **C3. Epoch/supersede/trailing-retry — 2 parallel machines.** Runtime reload queue
  (`reloadEpochSequence`/`supersededReloads`) vs web snapshot recovery
  (`recoveryEpoch`/trailing while-loop), plus three unrelated anti-spin timing constants. Fix:
  one epoch-queue primitive; keep DOM/React wiring local.
- **C4. SSE event contract defined on both ends.** Frame names (`${type}-begin/-chunk/-end`),
  begin/end envelopes, and the event-id grammar are built in `browserReviewServer.ts` and
  re-declared/regex-parsed in `mirror.ts`/`apiClient.ts`; client bounds (12 MiB / 1024 chunks)
  are unlinked from server bounds and only coincidentally compatible. Fix:
  `src/session/reviewEventProtocol.ts` owning names, envelopes, id grammar, and bounds derived
  from `MAX_BROWSER_REVIEW_SNAPSHOT_BYTES`.
- **C5. Reconnect/backoff — 4 schedulers, 1 verbatim duplicate.** `apiClient.ts` (exp/4 s),
  web `App.tsx` (exp/4 s + anti-spin), `brokerClient.ts` (fixed 3 s — re-implementing the
  scheduler of the connection it already configures), `session-broker/connection.ts`. Fix: one
  `createReconnectScheduler` in `@hunk/session-broker-core`; EventSource's built-in reconnect
  interplay stays client-side.

## D. Notes and validation

- **D1. Note byte bounds measured in two units.** Wire checks `body` and `markup` separately
  against `MAX_REVIEW_NOTE_BYTES`; broker/producer check whole-note JSON — so a note that
  passes action validation can poison the entire snapshot with a capacity error. Neither
  client pre-checks size, and the server's action-body cap is smaller than the largest
  "valid" note. Fix: one `reviewNoteWithinBounds` used by wire, broker, producer, and both
  composers.
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
- **D4. Canonical-file ↔ manifest consistency — 3 checks, 3 field lists.** Producer
  `registration.ts` (authoritative ~17 fields), web `parseCanonicalReviewFile` (12, and
  compares `flags`/`sourceResourceIds` via key-order-sensitive `JSON.stringify` — lazily
  inserted source ids can spuriously error a file), broker legacy check (10). Nobody compares
  canonical hunk _content_ to manifest hunks. Fix: one order-independent
  `assertCanonicalFileMatchesManifest` in core; producer self-check reuses it.
  (`contentManifest.ts` is legitimately different — a parity-test snapshot, not a validator.)
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

## E. Presentation helpers

- **E1. File stat badges.** Terminal `ui/lib/files.ts` `formatSidebarStat` (zero-hiding,
  truncation marker) vs web inline `+${additions} −${deletions}` in `treeSource.ts`. One
  shared formatter.
- **E2. Theme.** Web hardcodes two standalone palettes disconnected from `src/ui/themes` and
  the `AppTheme` mapping; whether the browser mirrors the terminal theme is an open product
  decision — decide before Phase 5, don't unify by default.

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
- **F2. Semantic command effects are closures instead of intent dispatches.** The ~15
  review-semantic commands (hunk/file/annotated navigation, start note, toggle gap, toggle
  agent notes, filter) run as App closures; a browser implementation would re-derive each
  behavior — the exact drift class of B1/B3/B6. Fix: lower semantic commands to
  `ReviewIntent`s (the Phase 1 store refactor is the same work); the browser fires them
  through the existing apply-action path, and the agent runtime's `hunk session` surface
  becomes a third consumer of the same lowering.
- **F3. Keymap resolution is terminal-owned.** Chords are shared config strings (`keymap.ts`,
  `[keybindings]`), but resolution against defaults and conflict handling lives with the
  terminal table; a browser keymap would duplicate it and drift on user rebinds. Fix: resolve
  user keybindings against the catalog once; each client maps resolved chords to its own event
  type and masks platform-reserved chords (browser `Cmd+W` etc.).
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
- **G2. Actor identity and multi-client selection policy.** Notes carry an optional `author`,
  but wire actions carry no actor/client identity — with a terminal, a browser, and agents
  attached to one session, nothing distinguishes who moved the selection or wrote a note, and
  B11 (viewport-driven selection) already showed the two clients fighting over shared
  selection. Decide the model once: actions carry a client/actor tag; selection is either
  shared-with-follow-mode or per-client-with-optional-follow (product decision); note
  authorship defaults from the actor. Wire fields in Phase 3, policy before Phase 5 PR 2.
- **G3. Semantic addressing / permalinks.** The prototype's URL fragment carries only the
  capability token — there is no grammar for addressing a file/hunk/line/note. Three consumers
  will need one: browser deep links and back/forward history, a terminal "copy link" command,
  and agent surfaces already addressing targets by file/hunk. One serialize/parse address
  grammar over semantic keys (`fileKey`/`hunkIndex`/side/line/noteId — never array indices or
  rendered rows) in `core/review`, used everywhere an address crosses a boundary. Core
  primitive in Phase 1; browser adoption Phase 5; opener fragments Phase 6.
- **G4. User-facing error catalog.** The repo already solves this once for agents:
  `src/session/agent/errors.ts` single-sources every message the generated skill quotes, with
  contract tests. The browser has no equivalent — action rejections (`invalid-action`,
  `stale-generation`, resource integrity failures) would surface as ad-hoc strings invented in
  `src/web`, drifting from what the terminal shows for the same failure. One error-code →
  user-message catalog beside the wire protocol, consumed by both clients (and reused by the
  agent surface where codes overlap). Phase 4 (codes stabilize) / Phase 5 (browser consumes).
- **G5. Undo, if it ever arrives.** Note editing today has no undo. If it is added, the
  history/undo semantics belong in the shared reducer (which client undoes what, across
  actors), never in one client's keyboard handler. Recorded as a placement rule, not work.

## Verification hooks

The per-phase verification ladder lives in `browser-review-rebuild.md` § "Per-phase seam
verification". A finding here counts as repaid only when all four hold: duplicate copies
deleted, their paths appended to the tombstone list in `scripts/source-boundaries.test.ts`,
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
