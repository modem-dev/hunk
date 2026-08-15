# Chunked syntax highlighting in Pierre

Status: investigation plus a working proof of concept. Nothing here is wired into the shipped
build, and no upstream pull request has been opened.

This is not the approach Hunk should take. A companion investigation moved the same work to a Bun
worker instead, and its main-thread stall is flat at a few milliseconds where windowing's stays
proportional to window size. What survives here is the upstream contribution: the inability to
highlight less than a whole file is a real gap in `@pierre/diffs`, their own `Virtualizer` runs into
it, and the patch below closes it.

## The question

Large contiguous diffs — a newly added file is the clearest case — stall the terminal while Hunk
highlights them. The suspicion was that `@pierre/diffs` can only highlight a whole file at once, so
Hunk has no way to break the work into pieces and yield between them.

That is correct as of `@pierre/diffs` 1.2.2, and still correct in 1.3.5.

## Why the whole file is highlighted at once

`renderDiffWithHighlighter` already accepts `startingLine` and `totalLines`, and
`iterateOverDiff` already implements a complete row-window walk behind them. The very first thing
the renderer does, though, is throw the window away unless the caller also asked for plain text:

```js
if (forcePlainText) {
  startingLine ??= 0;
  totalLines ??= Infinity;
} else {
  startingLine = 0; // <- any window the caller passed is discarded
  totalLines = Infinity;
}
```

So today there are exactly two modes: a highlighted whole file, or a windowed slice with no
highlighting at all. Hunk uses the first and never passes a window.

The gate is not arbitrary. Below it, `shouldGroupAll` concatenates every visible line of each side
into one string and hands it to Shiki in a single `codeToHast` call. That is what makes highlighting
correct: a TextMate grammar is stateful, so a window tokenized on its own starts with an empty rule
stack and mis-colors anything inside a block comment, template literal, or heredoc that opened
earlier in the file. Windowing and highlighting were mutually exclusive because nothing carried the
lexical state across a window boundary.

Two details soften the problem:

- Pierre already buckets **per hunk** when `diff.isPartial` is true, so patch-only diffs are already
  chunked. The single-giant-call path is specifically the complete-file case — which is exactly the
  added-file case Hunk cares about.
- Hunk makes that worse on purpose. `sourceBackedHighlight.ts` grafts full file text onto a partial
  diff so grammar state is right, which converts a cheap per-hunk render into one whole-file render.

## Shiki can already do this

Shiki 3.x exposes exactly the missing piece:

- `codeToHast(code, { grammarState })` starts tokenizing from a saved rule stack.
- `highlighter.getLastGrammarState(hast)` reads the state a render ended in.

Pierre already depends on both — `dist/shiki-stream/tokenizer.js` threads `grammarState` line by
line for streaming. Nothing new needs to be built in Shiki, and nothing needs to change in Pierre's
window walk. The change is to stop discarding the window, and to thread grammar state through the
existing bucket loop.

## The proof of concept

There are two patches, carrying the same change against different targets:

- `patches/pierre-upstream-windowed-highlight.patch` is the real one — TypeScript source plus tests,
  against `pierrecomputer/pierre@d9eb0ab`, verified with Pierre's own typecheck and test suite. Its
  draft PR description and open questions are in `docs/pierre-windowed-highlight-pr.md`.
- `patches/@pierre%2Fdiffs@1.2.2.patch` is the same change hand-applied to the published `dist` of
  the version this repo pins, so the benchmark below runs without building Pierre from source. It
  exposes the identical API.

Apply the `dist` one with:

```bash
bun patch @pierre/diffs
# copy the patch body over node_modules/@pierre/diffs/dist/utils/renderDiffWithHighlighter.js
bun patch --commit node_modules/@pierre/diffs
```

or, to try it without editing `package.json`:

```bash
patch -p1 -d node_modules/@pierre/diffs < "patches/@pierre%2Fdiffs@1.2.2.patch"
```

It does four things:

1. **Honors a window while highlighting, behind an opt-in flag.** `windowedHighlight: true` makes
   `startingLine`/`totalLines` take effect with highlighting on. It is a flag rather than being
   inferred from a window being present, so a caller that passes a range today keeps getting the
   whole diff instead of silently switching behavior.
2. **Threads grammar state in and out.** A new `grammarState` input, and a `grammarState` field on
   the result, carrying one state per side. State flows bucket-to-bucket within a call and
   window-to-window across calls. A side that contributed no lines to a bucket keeps its prior
   state rather than resetting.
3. **Disables the whole-array shortcut for windows.** `shouldGroupAll` would otherwise overwrite the
   output array with one bucket's lines; a window has to go through the existing sparse
   segment-fill path.
4. **Walks a single row axis when windowed.** This one is not obvious and is the part that took
   longest to find — see below.

### The `diffStyle: "both"` trap

`renderDiffWithHighlighter` iterates with `diffStyle: "both"`, which advances a unified row counter
and a split row counter independently and emits a line if it falls in _either_ window. Unified and
split row counts diverge whenever a change block has unequal deletion and addition counts, so
consecutive row windows overlap heavily. Measured on a 4000-line rewrite with 250-row windows:

```
additionLines: total=4000 never=0 once=744 duplicated=3256
deletionLines: total=4000 never=0 once=924 duplicated=3076
```

Coverage is complete, so the rendered output is fine — but 81% of lines get emitted more than once,
which makes grammar-state chaining nonsense, because each window re-consumes lines the previous
window already advanced past. The result was correct-looking output that drifted into comment
coloring a few hundred lines in.

The fix is to walk one axis. Windowed highlighting uses `diffStyle: "split"`, which keeps each side
line to exactly one row and keeps change pairs on a single row — which matters because Pierre's
word-level diff decorations are computed from a paired change callback. Under `"unified"` the pair
is split across two callbacks and intra-line highlighting would be lost entirely. Every branch of
`getChangeLineData` treats `"both"` and `"split"` identically, so `data-line-index` and the emitted
line metadata are unchanged.

### Where chaining is not valid

Grammar state may only be carried between windows while the emitted lines are contiguous in the
underlying file. Two cases break that:

- **Collapsed context.** If `expandedHunks` leaves gaps, the emitted lines skip source, and the
  carried state is stale. The proof of concept passes `expandedHunks: true`.
- **Partial diffs.** A patch-only diff's lines are not contiguous in the real file at all. Pierre
  already buckets these per hunk and starts each cold; the benchmark keeps that behavior by not
  chaining when `metadata.isPartial`.

A real upstream API should make this explicit rather than leaving it to the caller — either by
refusing to chain across a gap, or by returning a marker saying the state is only valid if the next
window starts at a given line.

## Results

`benchmarks/pierre-windowed-highlight.ts` reproduces these. It warms both paths before timing,
because Shiki resolves grammars lazily and an unwarmed first call otherwise absorbs a large one-time
cost. It detects whether the patch is applied and says so rather than failing.

Largest real source in the repo, rendered as a newly added file:

```
src/ui/diff/renderRows.tsx (2373 lines added)
  whole file : 255.6ms in one uninterruptible call
  window  250: 267.5ms across 10 windows, longest 36.7ms, identical=true
  window  500: 269.4ms across  5 windows, longest 66.3ms, identical=true
  window 1000: 236.3ms across  3 windows, longest 114.2ms, identical=true
```

A generated 8000-line file:

```
synthetic-generated.ts (8000 lines added)
  whole file : 660.6ms in one uninterruptible call
  window  250: 702.9ms across 32 windows, longest 27.7ms, identical=true
  window  500: 721.3ms across 16 windows, longest 58.2ms, identical=true
  window 1000: 673.8ms across  8 windows, longest 87.4ms, identical=true
```

Total CPU is essentially unchanged — windowing costs a few percent, it does not save work. The whole
win is granularity: the longest uninterruptible call drops from 661ms to 28ms, roughly 24x, which is
the difference between a frozen terminal and a responsive one. Hunk already serializes highlight
jobs through `setTimeout` in `queueHighlightedWork`, so smaller units drop straight into that queue
and let input and frame timers run between them.

The same benchmark then runs a correctness sweep: TypeScript, Python, and CSS, each in new-file,
deleted-file, full-rewrite, scattered-edit, and no-trailing-newline shapes, plus a partial patch, at
window sizes 64, 250, and 1000. Every case is compared byte-for-byte against the stock whole-file
render, and all 48 are identical. The languages are chosen for the shape of their multi-line
constructs — block comments, template literals, triple-quoted strings — since those are what a window
boundary can cut through.

## Is an upstream pull request plausible

Yes, and it is written: see `docs/pierre-windowed-highlight-pr.md`. It is three files against
`pierrecomputer/pierre@d9eb0ab`, and Pierre's own `packages/diffs` suite goes from 1504 to 1515
passing with zero failures.

What makes it a comfortable change to propose:

- It reuses machinery Pierre already ships — the window walk, the segment sparse-fill, the per-hunk
  buckets, and its own Shiki grammar-state usage in `shiki-stream`.
- It is opt-in behind a flag. Passing no window preserves today's behavior exactly, which is what the
  byte-identity checks demonstrate.
- Pierre has an obvious use for it too: its DOM `Virtualizer` already models `RenderRange` with
  `startingLine`, `totalLines`, `bufferBefore`, and `bufferAfter`, and currently has to choose
  between a whole-file highlight and an unhighlighted window for the same reason Hunk does.
- The existing code already flags this as a known gap: the branch that discards the range is
  commented "Maybe one day we warn about this?".

Open questions for the maintainers are carried in the PR draft: row space versus per-side line index
space, whether Pierre should police contiguity itself rather than trusting the caller, dual-theme
coverage, and whether `windowedHighlight` belongs on `ForceDiffPlainTextOptions` at all.

## What Hunk would do with it

Nothing in `src/` has been changed. The integration would be local to
`renderHighlightedDiff` in `src/ui/diff/diffRows.ts`: replace the single
`renderDiffWithHighlighter` call with a loop over windows, each scheduled through the existing
`queueHighlightedWork` timer, merging into the same `HighlightedDiffCode` shape the UI already
consumes. Publishing each window as it lands would additionally let the top of a large file paint
highlighted while the rest is still being tokenized, but that needs `useHighlightedDiff` to accept
progressive updates and is a separate change.

That work should wait until the upstream API is settled, so Hunk does not end up carrying a patched
dependency or a second highlighting path.
