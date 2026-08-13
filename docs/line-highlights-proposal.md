# Proposal: extension-contributed line highlights

Status: implemented. This document records the design, what a critical review
of the draft changed, and the resolution of its open questions. The authoring
contract lives in `docs/extensions.md`; ownership is mapped in
`docs/extension-architecture.md`.

An extension can add panes, file views, commands, keyboard modes, dialogs, and
whole VCS backends — but it could not mark **a range of characters inside a
diff line**. This is the smallest API that closes that gap, and it is smaller
than it looks because Hunk already renders exactly this kind of mark for its
own word-diff emphasis.

## The gap

Concretely: a search extension finds `readConfig` on line 214 and can jump the
review to that hunk, but cannot show the user _which characters_ matched. The
best it could do was quote the line on its own pane and highlight it there —
one row of indirection away from the code it is talking about, which defeats
the point.

`registerFileView` is the only nearby lever and it is the wrong one: presenting
a file as extension-supplied rows replaces Pierre's diff rendering wholesale,
trading syntax highlighting, word diff, and layout fidelity for the ability to
color a substring.

## What already existed

Hunk paints intra-line background ranges today. Pierre marks word-diff emphasis
spans with a `data-diff-span` attribute, and `flattenHighlightedLine`
(`src/ui/diff/pierre.ts`) turns them into `RenderSpan { text, fg?, bg? }` runs
carrying an emphasis background.

More importantly, Hunk already solves the hard part of this problem — **a
background is invisible unless it is resolved against the background it sits
on**. `MIN_WORD_DIFF_BG_DISTANCE` / `strengthenWordDiffBg` /
`resolveWordDiffHighlightBg` in `pierre.ts` blend an anchor color into the
line's own background until it clears a minimum perceptual distance, per line
kind and per theme. An added line already has a green background; a naive
highlight background is indistinguishable on it, which is precisely what a
first attempt at this produced. That machinery is the reason this API exists at
the tone level rather than the color level. The extension-facing version is
`lineHighlightToneBg` in `src/ui/diff/rowStyle.ts`, verified against every
built-in theme and line kind by tests.

## The shape

```ts
hunk.registerLineHighlighter({
  id: "matches",
  highlight: ({ file, signal, readDocument }) =>
    ExtensionLineHighlight[] | null | Promise<...>,
});
```

```ts
interface ExtensionLineHighlight {
  /** Which side the line belongs to; a context line may be addressed by either. */
  side: "old" | "new";
  /** 1-based source line number on that side. */
  line: number;
  /** [start, end) UTF-16 code-unit offsets into the line's raw source text. */
  range: readonly [number, number];
  /** What the mark means. The host decides what that looks like. */
  tone?: "match" | "current" | "info" | "warning" | "error";
}
```

Addressing by `(side, line, range)` rather than by rendered row is deliberate:
source coordinates survive split vs stack, wrapping, horizontal scroll,
collapsed context, and note insertion. Extensions never learn Hunk's row model,
which is the same boundary `registerFileView` and `DiffPane` already hold.

Invalidation is pull-based, identical in spirit to `ctx.fileViews.refresh`:
`highlight` is a pure derivation of the file plus an invalidation epoch, so a
search that moves to the next match bumps the epoch
(`ctx.highlights.refresh("matches")`, optionally `{ fileId }`-scoped) rather
than pushing new state into the host. There is no host-held mark state to go
stale across a reload. The epoch policy is the same one file views use,
extracted to `src/ui/lib/scopedEpochs.ts` and shared.

## Tones, not colors

The API does not accept a color. Three reasons, in order of importance:

1. **Visibility is not the extension's to get right.** The contrast problem is
   real, theme-dependent, and per line kind — `#334455` is legible on a context
   line and invisible on a green one. `tone` lets the host apply the word-diff
   minimum-distance guarantee to extension marks too.
2. **Themes stay coherent.** Hunk's theme guidance keeps official palette
   tokens separate from the semantic `AppTheme` mapping; a raw color from an
   extension punches straight through that.
3. **It is a smaller contract.** A tone can be re-mapped later; a color cannot.

Tone anchors map to existing semantic theme tokens (`accent`, `text`,
`badgeNeutral`, `fileModified`, `removedSignColor`); `current` carries a higher
distance floor so the active search hit reads against its `match` siblings.
Surfaces that cannot take a blend (transparent, non-hex) decline the mark —
the same degradation word diff uses.

## Where it plugs in

The instinct is to apply highlights where spans are built — `makeSplitCell` /
`makeStackCell` in `pierre.ts`. **That is the wrong layer.**
`buildDiffSectionRowPlan` is the shared plan consumed by _both_ rendering and
geometry measurement; feeding highlights into it would put them in the cache
key of the expensive, geometry-bearing artifact, so pressing `n` during a
search would re-plan whole files to change some colors.

Highlights are applied at **paint time** instead. The review confirmed the
placement argument holds, with two wiring caveats the draft missed:

- **Memoized rows repaint only when a prop changes.** `DiffRowView` compares
  props by reference, so the paint-time index is a real prop
  (`lineHighlights`), built per file in `PierreDiffView` and threaded through
  `DiffPane`/`DiffSection`. Per-file mark arrays keep stable identities across
  unrelated preparation runs, so an epoch bump repaints exactly the files whose
  marks changed.
- **Cell spans are shared cached arrays** (`flattenHighlightedLine` memoizes
  per HAST node; `aliasHighlightedContextLines` shares one array across context
  sides). Application therefore copies: spans are split at column boundaries
  with backgrounds overridden, before `sliceSpansWindow` (horizontal scroll)
  and `wrapSpans` (wrapping), which both preserve per-span colors for free.

The split of responsibilities:

| Layer        | File                                                     | Work                                                |
| ------------ | -------------------------------------------------------- | --------------------------------------------------- |
| Contract     | `src/extension-api/types.ts`                             | types (import-free), API v5                         |
| Registry     | `src/extensions/types.ts`, `runExtension.ts`, `apply.ts` | collect + resolve registrations                     |
| Preparation  | `src/ui/highlights/`                                     | bounded async, validation, caps, epochs             |
| Column model | `src/ui/diff/lineHighlightPaint.ts`                      | offsets → terminal columns; span repaint transform  |
| Tone → color | `src/ui/diff/rowStyle.ts`                                | `lineHighlightToneBg`, word-diff distance guarantee |
| Paint        | `src/ui/diff/renderRows.tsx`                             | apply per rendered cell, memo-aware                 |

That placement buys three properties by construction: geometry neutrality
(colors change, text never does, so measurement and wrapping cannot move),
windowed cost (only mounted rows consult the index), and no cache invalidation
(a highlight change is a repaint, never a re-plan).

## What the review surfaced

- **The offset mapping is derivable but not free.** Cell spans are already
  sanitized and tab-expanded, so raw code-unit offsets map through one owned
  conversion: sanitize-aware (control characters can shift offsets), tab-aware
  (a prefix expands to the same columns the full line's expansion gives it),
  and snapped outward to grapheme-cluster boundaries so a mid-surrogate or
  mid-cluster offset widens to the whole glyph instead of tearing it.
- **The static pager needs nothing.** `staticDiffPager.ts` never runs extension
  code, so highlights are interactive-only by construction; the docs say so
  explicitly rather than leaving it to be discovered.
- **Expanded collapsed-context rows are covered.** Gap rows render source
  slices, and the gap's old↔new correspondence resolves marks addressed to
  either side onto the loaded source line, keyed under both line numbers.
  Without loaded source those marks are silently invisible — matching the rows
  themselves.
- **Marks on invisible lines are not errors.** A mark inside a collapsed gap or
  absent from a partial patch is valid; the review just is not showing that
  line. Only structural garbage warns.
- **Extension file views are out of scope.** A file view already owns its rows'
  spans and tones; highlights apply to Hunk's own diff rendering only.
- **Theme changes re-resolve for free.** Tone resolution happens at paint time
  keyed by the theme object; nothing is cached against a stale theme.

## Validation and containment

- Out-of-range lines: silently invisible (see above). Inverted, empty, or
  non-integer ranges, bad sides, unknown tones: dropped, one warning per
  extension per file.
- Caps: 2,000 ranges per file, 100 per line; beyond either the file's
  highlights from that highlighter are dropped whole rather than truncated
  silently.
- Overlaps resolve deterministically: ranges sort by start column and the later
  range wins where they overlap.
- A throwing, rejecting, or timed-out `highlight` costs that file's marks and
  nothing else, bounded by the same timeout and concurrency discipline as file
  views.
- Precedence: extension marks override word-diff emphasis where they overlap
  (the more specific statement); cursor-line and copy-selection blends compose
  on top, since they are `bg => blend(bg)` functions over whatever background
  is present.

## Resolved questions

1. **Offset units** — UTF-16 code units into the raw line text. That is what
   `indexOf`/`RegExp.exec` return against `file.patch` lines, so it is the only
   contract extensions can satisfy without reimplementing Hunk's measurement
   stack. The host clamps to cluster boundaries, widening outward.
2. **Context lines** — one mark, mirrored to both halves in split view, found
   through either side's line number in stack view. A context line is one
   occurrence that split view happens to draw twice; changed lines are separate
   addresses with separate marks, which is what makes `n` step from an old-side
   hit across to a new-side hit.
3. **`current` as a tone** — kept as a tone. It is the emphatic variant of
   `match` with a higher contrast floor; a separate concept would be more API
   for the same pixels.
4. **Interaction with word diff** — the extension mark wins where they overlap.
   It is the more specific statement, and it is stated in the docs.
5. **`matches` pre-filter** — dropped. File views need `matches` because view
   availability is user-visible (the per-file View menu); highlights have no
   visible selection state, so a cheap `highlight` returning `null` makes the
   pre-filter pure optimization with no observable role.

## What else this unlocks

Search is the weakest justification on this list.

- **Diagnostics inline.** `tsc`, `eslint`, `clippy`, `ruff` output mapped onto
  the exact columns of the changed lines — "this PR introduces this error,
  here" during review rather than in CI later.
- **Secret scanning.** Mark the exact token that tripped a rule, instead of
  naming the line in a pane.
- **Trojan-source defense.** Bidi control characters, homoglyphs, and
  zero-width characters are invisible _by construction_ in a diff viewer.
  Marking those ranges is a security feature a review tool is uniquely placed
  to offer.
- **Coverage.** Uncovered added ranges, straight from an lcov file.
- **Provenance.** Which ranges an agent wrote versus a human — squarely in
  Hunk's stated purpose of understanding coding-agent changesets.
- **Occurrence highlighting.** Every use of the identifier under the cursor,
  the way an editor does.
- **Repo conventions.** A `.hunk/extensions/` extension marking banned APIs,
  `any`, stray `console.log`, or missing license headers for every reviewer on
  the team.
- **Anchored agent notes.** Notes attach to lines today; a range would tie a
  note to the exact expression it discusses.
- **Agent-driven marks.** With the session daemon already brokering agent
  commands into live sessions, an agent answering "where does this change
  behavior?" could light up the ranges in the user's terminal as it explains.
  Nothing else in the ecosystem can do that.

## Companion gap (separate PR)

`ctx.navigation` reaches files and hunks; the finest target is `selectHunk`. A
highlight tells you which characters matched, but the review still lands on the
hunk. `revealLine(fileId, side, line)` would complete it, and the internals
already have the pieces — `firstLineCursorInHunk` and `revealLineCursor` in
`useReviewController.ts` do exactly this for the host's own line cursor.
Deliberately kept out of the highlight change to keep both reviewable.
