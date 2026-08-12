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
- **A2. Trailing-context existence — 3 formulations.** `pierre.ts` `trailingCollapsedLines`,
  producer `src/session/app/registration.ts` (~:131-139, boolean `hasTrailingContext`), core
  `expansion.ts`. The browser can offer a "Trailing context" button whose expansion core then
  rejects (`gap-not-found`). Fix: one `reviewTrailingGap(file)` in core.
- **A3. Per-side hunk range — 4 implementations, one wrong.** `core/liveComments.ts`
  `hunkLineRange`, `core/review/anchors.ts` `reviewHunkRange` (correct), web
  `pierreDocument.ts` `sideRange` (uses changed-line counts `deletionLines`/`additionLines` as
  span lengths — wrong for hunks with leading context, misplacing notes in the browser), and
  `ReviewStream.tsx` re-filtering against manifest ranges. Fix: `reviewHunkRange` everywhere;
  collapse `hunkLineRange` into it.
- **A4. Source-line splitting for expanded context — 3 implementations, browser skips
  normalization.** Terminal `expandCollapsedRows.ts` `sliceLines` and core `anchors.ts`
  `normalizedReviewSourceLines` agree (CRLF-normalize, strip one trailing newline); web
  `ReviewStream.tsx` does a bare `split("\n")` — `\r` glyphs, phantom EOF line, and context
  digests that can mismatch on reload. (`sourceBackedHighlight.ts` `splitSourceLines` is a
  legitimate fourth variant — Pierre's highlighter needs retained newlines; comment it.) Fix:
  export and adopt `normalizedReviewSourceLines`.
- **A5. Expansion side policy `deleted ? "old" : "new"` — 3 copies.** Core `intents.ts`
  (authoritative), terminal `diffSectionRowPlan.ts` (recomputed instead of reading `gap.side`),
  web `pierreDocument.ts` fallback ordering. Fix: thread `gap.side`; export
  `reviewExpansionSide(file)`.
- **A6. Hunk content-index rebasing — 2 copies, opposite `isPartial` conclusions.** Web
  `pierreDocument.ts` `isolatePierreHunk` vs terminal `sourceBackedHighlight.ts` (~:108-199).
  Fix: one `rebaseReviewHunk(hunk, origins)` in core.
- **A7. File split/unified line totals — web guesses.** `pierreDocument.ts` reconstructs
  `splitLineCount`/`unifiedLineCount` by reducing over hunks; terminal reads Pierre's
  authoritative values. Mis-sizes browser virtualization when the parser counts rows outside
  hunk spans. Fix: carry both on `ReviewFileV1`.
- **A8. Empty-diff explanation — 3 variants with different precedence.** Terminal
  `renderRows.tsx` `diffMessage` (rename-pure first), web `ReviewStream.tsx` (binary first),
  `staticDiffPager.ts` (extra cases). Same file can explain itself differently per client.
  Fix: `reviewEmptyDiffReason(file)` in core.
- **A9. STML tag vocabulary — parse shared, tag semantics forked.** Terminal
  `ui/lib/stml/layout.ts` handles the full vocabulary; web `ReviewNote.tsx` handles a subset
  (everything else flattens to `<span>`) and accepts a `<tag>` alias the terminal lacks. Fix:
  `stmlTagRole(tag)` in `core/review/stml.ts`; both renderers switch on roles.
- **A10. Default line target for a hunk note — 2 divergent rules.** Terminal
  `core/liveComments.ts` `firstCommentTargetForHunk` (first added line, else first deleted);
  web `App.tsx` (hunk's first line — usually context). Same action anchors to different lines
  per client. Fix: `reviewDefaultHunkLineTarget(hunk)` in core, used by both (and by reveal).
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
- **B2. Wrap vs clamp policy split.** `moveToFile` clamps; `moveToAnnotatedFile` wraps
  (`ui/lib/reviewState.ts`). Encode per-scope wrap policy in the `selection/move` intent.
- **B3. File-jump semantics — hard-coded identically in both clients.** "Hunk 0 + file-top
  reveal" in terminal `App.tsx`/`useReviewController.ts` and web `App.tsx`; the terminal-only
  forward-cross-file alignment rule has no web counterpart. Fix: `selection/select-file`
  intent owning the rule.
- **B4. Selection fallback after reload/filter — 2 divergent answers.** Terminal
  `resolveSelectedFile` returns undefined (renders "no file"); web `validSelection` and
  `treeSource.reset` silently fall back to `files[0]`. Core permits `fileKey: null`. Fix:
  `selectNormalizedSelection`/`selectFallbackFileKey` selectors; delete both client fallbacks.
- **B5. Filter matching — 3 matchers.** Core `reviewFileMatchesFilter` (path, previousPath,
  agentSummary), terminal `filterReviewFiles` (normalized paths), web tree search
  (canonicalPath only) — browser sidebar and stream can disagree on the same query. Also
  live-per-keystroke (terminal) vs apply-on-Enter (web, which clobbers in-flight typing on
  snapshot). Fix: one matcher; one committed-vs-live decision.
- **B6. Reveal-target derivation — web re-derives, wrongly.** Web `App.tsx` recomputes the
  hunk target line (`newRange ? "new" : "old"`), duplicating core `canonicalLineForHunk` which
  prefers by side counts and requires a backed line — pure-deletion hunks scroll the wrong side
  in the browser. Fix: `selectRevealTarget(state)` selector; clients only resolve DOM/rows.
- **B7. "Jump to note" target — terminal geometry decides, web ignores.** The
  active-note choice lives in `DiffPane.tsx` row scanning; web never reads
  `reveal.scrollToNote`. Fix: `selectActiveRevealNoteId(state)` in core.
- **B8. Notes-by-hunk grouping — web re-filters by range containment.** `ReviewStream.tsx`
  drops annotations whose anchor came from core's fallback path or expanded context even after
  `pierreDocument` accepted them — notes silently disappear in the browser. Fix: group by
  `ownerHunkIndex` via a shared `selectNotesByHunk`.
- **B9. Note-visibility policy — two core predicates for one rule.**
  `selectors.ts` `reviewNoteVisibleByPolicy` (web path) vs `notes.ts` `alwaysShowReviewNote`
  (terminal path). Collapse to one predicate over `{source}`.
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

## Verification hooks

- The seam boundary tests (`scripts/source-boundaries.test.ts`) keep deleted copies deleted.
- Renderer parity tests (Phase 5 gate) drive shared fixtures through the terminal planner and
  browser projection and assert identical note placement, gap addressing, reveal targets, and
  default note targets — the drift class import gates cannot catch.
- `contentManifest.ts` should additionally cover derived geometry (A1–A4) so parity snapshots
  fail when a renderer re-derives instead of consuming core.
