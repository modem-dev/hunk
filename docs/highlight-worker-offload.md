# Highlighting in a Bun Worker

Status: measured prototype. Nothing in `src/` has changed.

## The problem

`renderDiffWithHighlighter` highlights a whole file in one uninterruptible call. Hunk calls it from
`loadHighlightedDiff` on a timer, which keeps highlight jobs from starving each other but does
nothing about the length of any single call: an 8000-line added file freezes the terminal for the
better part of a second, and a 30,000-line one for about three.

Hunk makes it worse on purpose. `sourceBackedHighlight.ts` grafts full source text onto a partial
diff so grammar state is correct, converting what would be a cheap per-hunk render into a whole-file
one.

`@pierre/diffs` cannot be asked for less. It accepts `startingLine`/`totalLines` and has a complete
row-window walk behind them, but discards the range unless the caller also asks for plain text —
because a window tokenized alone starts from an empty TextMate rule stack and mis-colors anything
inside a construct that opened earlier. So the options are a highlighted whole file or an
unhighlighted window.

This investigation takes the other route: keep the whole-file call, move it off the thread that
paints. That is what Pierre itself does for the browser — a worker pool re-renders and swaps the
highlighted result in, with DOM virtualization keeping the document small and a hard cliff at
100,000 lines past which nothing is highlighted at all.

Reproduce with `bun run bench:highlight-worker-offload`.

## What was measured

Wall time is the wrong metric. What freezes a terminal is how long the main thread is blocked, so
the benchmark runs a 1ms interval throughout and records the largest gap between its ticks. An idle
pass establishes the floor, which reads about 2ms.

Each cell is the median of 5 repetitions, because a single sample of the worst stall varies by up to
3x. The reply shapes rotate which runs first, since whichever goes last inherits warmer JIT state.

Worst main-thread stall, by how the worker replies:

| Added file  | Main thread | HAST  | Compact | Compact, lazy | Columnar, transferred + lazy |
| ----------- | ----------- | ----- | ------- | ------------- | ---------------------------- |
| 2000 lines  | 182ms       | 8ms   | 7ms     | 3ms           | **3ms**                      |
| 8000 lines  | 779ms       | 32ms  | 21ms    | 9ms           | **3ms**                      |
| 30000 lines | 2878ms      | 146ms | 109ms   | 32ms          | **6ms**                      |

Worker boot plus Shiki init is a one-time ~330ms. Wall time is within noise of the main-thread
render for the columnar shape (2978ms against 2878ms at 30k lines), so the encode and transfer are
close to free in total-CPU terms.

Treat the small numbers as an order of magnitude, not a measurement. The columnar cell at 30k lines
has read anywhere from 5ms to 24ms across runs on a shared machine, and the main-thread baseline
moves by several hundred milliseconds between runs too. The claim these numbers support is not "6ms"
but "single-digit to low-tens of milliseconds, and not growing with the file" — which is the
difference that matters against a baseline that grows to seconds.

The last column is the result: the stall stops scaling with file size, across a 15x range, against a
main thread that goes from 182ms to 2878ms.

## Getting there took three changes, and only the third one mattered most

**Shrinking the payload.** Pierre's HAST is 20.8MiB for a 30k-line file; the compact token encoding
is 1.9MiB, because Hunk's span flattener reads only three things per token — the text, one
foreground color, and whether the token carries `data-diff-span`. Colors intern into a per-file
palette of about 11 entries. Worth doing, but on its own it only moved 146ms to 109ms, because the
tokens still have to be rebuilt into the HAST the row builders read, and that rebuild is main-thread
work.

**Rebuilding lazily.** A terminal draws tens of rows no matter how many the file has. Rebuilding one
viewport on arrival instead of the whole file takes 109ms to 32ms, and the rest can be rebuilt as
the user scrolls. This is the change that breaks the link between file size and arrival cost for the
rebuild.

**Transferring instead of cloning.** What remained at 32ms was structured clone itself: the compact
payload is still an object graph of a million small arrays, and deserializing it happens before any
of our code runs. The columnar shape sends one text blob plus flat `Int32Array`s — four ints per
token, two per line — and hands the buffers over in `postMessage`'s transfer list, which moves them
rather than copying. That takes 32ms to 6ms.

Each change is cheap on its own and they compose. The order matters for understanding, though:
without lazy rebuilding, transferring buffers would just move the cost around, and without
transferring, lazy rebuilding leaves deserialization as the floor.

Both wire shapes are verified against Pierre's HAST by round tripping through the real worker — not
a local copy of the encoder — and running Hunk's real `buildSplitRows` over each result. A rewrite
fixture covers word-diff emphasis (818 spans) and a new-file fixture covers every line with no
collapsed context (13,750 spans). Compact and columnar are both identical to HAST on both fixtures.

## Workers do survive `bun build --compile`

This was the risk that could have killed the approach, since Hunk ships a compiled binary. Two
things are required, and both are easy to get wrong:

1. The worker must be passed to `bun build --compile` as an **additional entrypoint**. Without it the
   compiler bundles only the main entry and the binary fails at runtime with
   `ModuleNotFound resolving "/$bunfs/root/highlight-worker.ts"`.
2. The `new Worker(new URL(...))` specifier must end in **`.js`**, not `.ts`. Bun resolves
   `./highlight-worker.js` to the TypeScript file when running from source and to the compiled
   entrypoint inside the binary, so one spelling covers both. `./highlight-worker.ts` and
   `./highlight-worker` both work from source and both fail compiled — a failure mode that would
   only ever show up in a release build.

Binary cost, measured on a standalone case: a bare Bun binary is 99.3MB, and adding the worker
entrypoint with Pierre and Shiki reached 109.4MB. Hunk's binary already carries Pierre and Shiki for
the main thread, so the incremental cost is whatever the bundler duplicates across the two
entrypoints rather than the full 10MB — that has not been measured against Hunk's real build.

## The alternative that was measured alongside this

The other way to attack the same freeze is to keep the work on one thread and cut it into row
windows, patching Pierre to honor a window while highlighting and threading grammar state across
boundaries. That was prototyped and measured separately; it reaches about 28ms per window at
250-row windows on the 8000-line file.

|                           | Windowed highlight        | Worker offload                                               |
| ------------------------- | ------------------------- | ------------------------------------------------------------ |
| Worst stall, 8000 lines   | ~28ms at 250-row windows  | **3ms**                                                      |
| Worst stall, 30000 lines  | scales with window size   | **6ms**                                                      |
| Scales with file size     | Per window, yes           | No                                                           |
| Depends on                | An upstream Pierre change | Nothing external                                             |
| Main thread does the work | Yes, in slices            | No                                                           |
| Total CPU                 | Unchanged                 | Within noise                                                 |
| Memory                    | Unchanged                 | A second Shiki instance per worker                           |
| Failure mode              | None found                | Silent breakage in compiled builds if the specifier is wrong |

Before the payload work above, the two were close enough that the choice came down to architecture.
They are not close now. Windowing's stall is proportional to window size and the main thread still
performs every millisecond of the highlighting; the worker's is flat at a few milliseconds and the
main thread performs almost none of it.

The two remain compatible — a worker could render windows and stream them — but there is no longer a
performance argument for windowing standing alone. Its remaining advantages are that it needs no
second Shiki instance and has no compiled-build failure mode. It is still worth sending upstream on
its own merits, since the missing capability is a real gap in `@pierre/diffs` that their own
`Virtualizer` runs into.

## What integration would actually involve

Not yet done, and larger than the benchmark makes it look:

- `HighlightedDiffCode` is HAST today, and `flattenHighlightedLine` caches flattened spans in a
  `WeakMap` keyed on HAST node identity. A compact payload either rebuilds throwaway HAST nodes to
  keep that cache (what the benchmark does, to prove equivalence) or replaces the cache with
  something keyed differently.
- `aliasHighlightedContextLines` and `remapSourceBackedHighlight` both manipulate the HAST arrays and
  would need compact-aware equivalents.
- The worker needs Hunk's registered custom syntax themes, since `ensureSyntaxHighlightThemeRegistered`
  derives content-addressed themes from user config on the main thread.
- `loadHighlightedSourceLines`, used by gap expansion, goes through `renderFileWithHighlighter` and
  would want the same treatment or it becomes the remaining stall.
- Lifecycle: when to spawn, whether to keep a pool, and what happens to in-flight requests when the
  theme changes or the review reloads.
