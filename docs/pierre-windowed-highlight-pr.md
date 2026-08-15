# Draft upstream PR: windowed syntax highlighting in `@pierre/diffs`

Not submitted. This is the branch and description we would open against
[`pierrecomputer/pierre`](https://github.com/pierrecomputer/pierre) once the open questions at the
bottom are settled with its maintainers. Background and Hunk-side measurements are in
`docs/pierre-chunked-highlighting.md`.

The patch is `patches/pierre-upstream-windowed-highlight.patch`, in `git format-patch` form against
`pierrecomputer/pierre@d9eb0ab` (the v1.3.5 development head). Apply it with:

```bash
git clone https://github.com/pierrecomputer/pierre
git -C pierre am < patches/pierre-upstream-windowed-highlight.patch
```

## Shape of the change

Three files, +435 / -21:

| File                                                            | Change                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/diffs/src/types.ts`                                   | `DiffGrammarState`, two new option fields, one new result field |
| `packages/diffs/src/utils/renderDiffWithHighlighter.ts`         | Honor the window, thread grammar state, walk a single row axis  |
| `packages/diffs/test/renderDiffWithHighlighterWindowed.test.ts` | 11 tests                                                        |

No other module changes. No internal caller passes a range with `forcePlainText: false` today, so
nothing else in that repo is affected.

## Verification actually run

Against the real upstream toolchain, in a clone at `d9eb0ab`:

- `tsc --noEmit` on `packages/diffs` — clean.
- `bun test` on `packages/diffs` — **1515 pass, 0 fail** (1504 before the new tests).
- `oxfmt --check` on the three files — clean.
- `oxlint --type-aware` on the three files — one warning, `no-useless-default-assignment` on the
  pre-existing `theme: themeOrThemes = DEFAULT_THEMES` destructure. Confirmed identical on the
  unmodified `HEAD`, so it does not come from this change.
- Negative control: reverting only the `diffStyle` line fails 4 of the 11 new tests, so the suite
  covers the subtle half of the change rather than just the obvious half.

`moon run root:format root:lint` was not run — moon and proto are not installed here, so the
underlying `oxfmt` and `oxlint` binaries were invoked directly with the arguments the moon tasks use.

---

## PR description

### Title

`feat(diffs): support windowed syntax highlighting`

### Body

`renderDiffWithHighlighter` already accepts `startingLine` / `totalLines`, and `iterateOverDiff`
already implements the whole windowed walk behind them — but the range is discarded unless
`forcePlainText` is set:

```ts
} else {
  // If we aren't forcing plain text, then we intentionally do not support
  // ranges for highlighting as that could break the syntax highlighting, we
  // we override any values that may have been passed in.  Maybe one day we
  // warn about this?
  startingLine = 0;
  totalLines = Infinity;
}
```

So a caller can have a highlighted whole file, or an unhighlighted window, but not a highlighted
window. On a large added file that means one uninterruptible tokenize pass — precisely the work a
virtualizing caller most wants to break up. `Virtualizer` already models a `RenderRange` with
`startingLine`, `totalLines`, `bufferBefore`, and `bufferAfter`, and hits the same wall.

The comment's reasoning is right: a window tokenized on its own starts from an empty rule stack and
mis-colors anything inside a block comment, template literal, or heredoc that opened earlier. But
Shiki can continue from a saved state via `codeToHast(code, { grammarState })` and
`getLastGrammarState(hast)`, and this package already relies on that in `shiki-stream`. The window
only needs somewhere to carry it.

**What this adds**

```ts
let grammarState: DiffGrammarState | undefined;

for (let startingLine = 0; startingLine < rows; startingLine += 250) {
  const result = renderDiffWithHighlighter(diff, highlighter, options, {
    forcePlainText: false,
    windowedHighlight: true,
    startingLine,
    totalLines: 250,
    expandedHunks: true,
    grammarState,
  });
  grammarState = result.grammarState;
  // merge result.code into the sparse output the same way the plain-text path does
}
```

- `windowedHighlight?: boolean` opts in. It is a flag rather than being inferred from a range being
  present, so an existing caller that passes a range with highlighting on keeps today's behavior
  instead of silently switching to windowed output.
- `grammarState?: DiffGrammarState` carries lexical state in, and `ThemedDiffResult.grammarState`
  carries it out. It is per side, because the deletion and addition sides are tokenized as two
  separate documents. State also flows bucket to bucket inside a single call, since a window buckets
  per hunk. A side that contributed no lines to a bucket keeps its prior state rather than resetting.
- `shouldGroupAll` is disabled for a window, since it would otherwise replace the whole output array
  with one bucket's lines instead of going through the existing sparse segment fill.

**The `diffStyle` change is the subtle part**

Windowed highlighting iterates with `'split'` instead of `'both'`. `'both'` advances the unified and
split row counters independently and emits a line landing in _either_ window, so consecutive windows
overlap wherever the two counts diverge. On a 4000-line rewrite with 250-row windows, 81% of side
lines were emitted more than once. Coverage is still complete so the rendered output looks fine, but
grammar-state chaining becomes meaningless, because each window re-consumes lines the previous one
already advanced past — the symptom was correct-looking output drifting into comment coloring a few
hundred lines in.

`'split'` emits each side line exactly once and keeps a change's deletion and addition on the same
row, which is what `computeLineDiffDecorations` needs — under `'unified'` the pair arrives as two
separate callbacks and intra-line highlighting would be lost. Every branch of `getChangeLineData`
already treats `'both'` and `'split'` identically, so the emitted line metadata is unchanged.

**Constraints, documented on the option**

Chaining is only valid while consecutive windows cover the file contiguously. Callers must pass
`expandedHunks: true` so no context is skipped, and must not chain across a partial diff, whose lines
are not contiguous in the real file. The tests cover a partial diff rendering correctly with chaining
off.

**Compatibility**

Passing no window is byte-for-byte unchanged, and no `grammarState` is returned. The new tests assert
that a range passed without `windowedHighlight` still renders the whole diff.

**Tests** — `packages/diffs/test/renderDiffWithHighlighterWindowed.test.ts`, 11 cases:

- a range is ignored unless `windowedHighlight` is set, and no grammar state is returned
- `windowedHighlight` renders exactly the requested window and does return grammar state
- windows write each side line exactly once, on a diff whose unified and split counts diverge
- windowed output equals the whole-diff render, for a new file and for a rewrite, at window sizes 13,
  25, and 100
- dropping the grammar state between windows _does_ change the output, so the threading is shown to
  be load-bearing rather than incidental
- a partial diff still matches the whole-diff render

**Measurements** (8000-line added file, `pierre-dark`, `shiki-wasm`):

| Render          | Total   | Longest single call |
| --------------- | ------- | ------------------- |
| whole file      | 660.6ms | 660.6ms             |
| 250-row windows | 702.9ms | 27.7ms              |
| 500-row windows | 721.3ms | 58.2ms              |

Windowing costs a few percent of total CPU and saves no work. The point is that the longest
uninterruptible call drops roughly 24x, which is the difference between a frozen UI and a responsive
one.

### Questions for maintainers

1. **Row space or side space?** The window is expressed in row space to match `RenderRange`, which is
   what forced the `'split'` axis choice. Expressing it in per-side line-index space would sidestep
   that entirely and map more directly onto how buckets are built, at the cost of no longer lining up
   with `RenderRange`. Happy to switch.
2. **Should Pierre police contiguity itself?** Right now the "no gaps, no partial diffs" rule is
   documented on the option and left to the caller. Pierre could instead detect a gap during
   iteration and drop the incoming state, which would make the option harder to misuse.
3. **Dual themes.** Only the single-theme path is tested here. `codeToTokensWithThemes` does merge
   and propagate a per-theme grammar state, so it should work as-is, but I have not exercised it and
   would rather hear what coverage you would want.
4. **Naming.** `windowedHighlight` sits on `ForceDiffPlainTextOptions`, which is now doing more than
   its name suggests. Renaming the interface is breaking; adding a sibling options bag is not. No
   strong opinion.
