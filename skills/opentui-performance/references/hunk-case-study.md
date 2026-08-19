# Case study: Hunk's OpenTUI review stream

This case study records reusable evidence from one React/OpenTUI application. Do not copy its numeric
thresholds, cache budgets, or domain policies into another product without measuring.

## Workload

Hunk renders a terminal-native, multi-file diff review stream with:

- syntax-highlighted split and stack rows;
- one global scroll coordinate system;
- sidebar navigation;
- selected hunk rails and current-line paint;
- wrapped and unwrapped layouts;
- inline notes with deterministic height;
- file-level and row-level windowing;
- async source loading and optional worker highlighting.

A navigation benchmark used many files with one hunk per file, making each `]` press a cross-file
jump. This intentionally stressed section mounting, syntax rows, sidebar selection, reveal, and
OpenTUI paint.

## Evidence snapshot

The retained renderer work shipped in [Hunk PR #803](https://github.com/modem-dev/hunk/pull/803)
(commit `dc66723b`). Its final comparison used Bun 1.3.10 on Linux x64, a 240×28 test-renderer
viewport, a 180-file × 120-line fixture, and nine alternating fresh-process baseline/candidate pairs:

| Metric                       |     Main | Retained change |
| ---------------------------- | -------: | --------------: |
| Cross-file navigation median | 69.94 ms |        46.59 ms |
| Cross-file navigation p95    | 96.04 ms |        56.98 ms |
| Scroll median                |  1.63 ms |         1.15 ms |
| Scroll p95                   | 12.90 ms |         5.27 ms |
| Post-navigation heap         | 147.8 MB |        101.4 MB |
| Post-navigation RSS          | 590.6 MB |        429.7 MB |

A later opt-in worker study behind [Hunk PR #810](https://github.com/modem-dev/hunk/pull/810)
held the visible changed region at 16 lines while sweeping source sides. It used nine fresh processes
through 500 lines and five above that; the table shows medians for inline versus worker execution:

| Source-side lines |        Navigation | First fully colored frame penalty | Maximum render flush |
| ----------------: | ----------------: | --------------------------------: | -------------------: |
|                40 |  24.49 → 14.39 ms |                            +46 ms |     64.94 → 10.88 ms |
|               100 |  33.32 → 14.88 ms |                            +49 ms |     76.70 → 11.01 ms |
|               200 |  43.08 → 15.81 ms |                            +50 ms |      92.32 → 9.76 ms |
|               500 |  77.95 → 17.13 ms |                            +61 ms |    132.13 → 13.89 ms |
|             1,000 | 138.23 → 18.91 ms |                            +59 ms |    201.00 → 12.42 ms |
|             2,000 | 257.55 → 25.25 ms |                            +69 ms |    322.78 → 14.95 ms |

These snapshots explain the conclusions below; they are not universal OpenTUI baselines. Re-run raw
samples on the target runtime, platform, fixture, and renderer version.

## Profile evidence

The initial hot path combined:

- selection-driven React invalidation;
- syntax token `<span>` forests;
- newly mounted file sections;
- adjacent files mounted only to warm highlighting;
- unstable pane actions repainting sidebar rows;
- main-thread syntax highlighting;
- Yoga, text-buffer, native/WASM paint, and render flushing.

Controlled runs showed that pre-highlighting helped but did not explain all latency. Suppressing
selection paint helped independently. React Profiler commits were initially much larger, but after
structural fixes React accounted for only a fraction of remaining wall time; CPU profiles still
showed layout, buffer, native/WASM, and highlighting work.

## Structural wins

### Prefetch without mounting

Adjacent syntax data was useful, but mounting adjacent file row trees was not. Separating the
highlight prefetch set from the file render window reduced navigation work and retained memory while
preserving selected-target mounting.

Generic lesson: data horizon and render horizon are independent.

### Direct `StyledText` rows

Ordinary fixed-height rows already contained ordered syntax/style runs. The old path expressed them
as many React spans, which OpenTUI converted into text-node renderables, recursively gathered into
`StyledText`, and wrote to a text buffer.

The fast path builds final chunks directly and passes one `StyledText` payload to one text host.
Wrapping, copy selection, current-line ranges, and richer painting retain an expressive fallback.

This removed React fibers and persistent host text nodes, reduced dirty notifications and recursive
style collection, and materially lowered retained heap. It was a larger win than selection-invariant
row caches.

Generic lesson: when data is already a display list, avoid rebuilding a host object graph merely to
flatten it again.

### Stable capability objects

Pane navigation callbacks changed identity on every selection render, defeating memoized sidebar
rows. A stable action object delegates through latest-value refs, preserving behavior while stopping
selection-wide repaint propagation.

Generic lesson: extension and capability APIs are identity-bearing props in hot trees.

### Shared deterministic geometry

Hunk builds one row plan per file and derives measurement, rendering, anchors, reveal, and windows
from it. File sections and rows are windowed separately with exact spacers. Paint-only selection and
line marks do not change the geometry plan.

Generic lesson: exact pre-mount geometry unlocks reliable hierarchical virtualization.

## Experiments discarded

### Row-content `WeakMap` caches

Caches added code and retained objects for a gain inside run-to-run noise. Removing them did not hurt
the final benchmark.

Lesson: structural elimination beats caching repeated unnecessary structure.

### Separate rail renderables

Splitting one-character selection rails into separate text/box hosts narrowed React invalidation but
added OpenTUI/Yoga nodes. Navigation regressed.

Lesson: fewer host renderables can beat finer component granularity.

### Explicit one-row dimensions

Adding width/height constraints in hope of skipping intrinsic text measurement did not reduce layout
cost and increased memory.

Lesson: verify how the installed renderer marks and measures nodes before adding constraints.

### Generic React deferral

A `useDeferredValue` experiment barely changed scroll p95, worsened median scrolling, and increased
memory. Completed highlights were also visible through a shared cache, so React priority did not
control the whole publication path.

Lesson: transitions cannot schedule work that bypasses them through caches or native host updates.

### Smaller overscan and removed reveal settling

Reducing overscan or removing a zero-delay reveal settle improved a microbenchmark but broke distant,
backward, bottom-clamped, note, or window-mount navigation tests.

Lesson: geometry and settling safeguards require adversarial interaction coverage, not only pure
helper tests.

## Worker threshold study

Hunk's opt-in fast mode sends eligible highlighting to one serialized worker. Sweeping source-side
sizes showed a consistent trade:

- input and maximum event-loop stalls improved at every tested size;
- the plain frame appeared sooner;
- cold syntax color completed later because worker startup and queueing continued;
- lower thresholds queued more speculative work and could delay color catch-up during rapid mixed
  navigation;
- worker RSS was a visible fixed cost on tiny reviews, while main-thread heap often fell.

A representative sweep found that lowering a line threshold improved navigation dramatically, but
scroll p95 could worsen when a worker result landed during a wheel tick. The threshold itself did
not determine scroll cost once a file was eligible; file shape, token complexity, mounted rows, and
completion timing mattered.

Generic lessons:

1. Benchmark the actual eligible worker path.
2. Measure first plain frame and first fully styled frame separately.
3. Include mixed-size rapid navigation to expose FIFO head-of-line blocking.
4. Treat worker-result repaint as part of worker performance.
5. Prefer selected/visible priority over file-order FIFO.
6. Do not infer a universal threshold from line count alone.

## Measurement corrections

Several benchmark interpretation issues mattered:

- A default fixture below the worker threshold said nothing about fast mode.
- A scroll timer that excluded deferred viewport synchronization was not directly comparable to a
  navigation timer that included semantic commits and queued work.
- With eight scroll ticks, nearest-rank p95 was the slowest tick.
- Fresh-process samples were required because highlighter, worker, cache, renderer, and heap state
  materially changed later runs.
- Memory reductions corroborated the claim that fewer persistent renderables—not timer movement—drove
  the direct-text improvement.

## Validation that protected the product

Retained changes passed:

- focused render and worker parity tests;
- complete unit tests;
- PTY navigation, scrolling, wrapping, notes, and highlighting tests;
- real-TTY transcript smoke;
- Windows and compiled-worker checks;
- manual terminal verification.

The most valuable failures were not benchmark failures: full UI tests exposed reveal and windowing
regressions that focused geometry tests missed.

## Portable conclusions

- Optimize the host scene graph, not only React components.
- Keep one geometry model across render and interaction.
- Window React trees even when the host supports culling.
- Do not mount to prefetch.
- Stabilize props before trusting memoization.
- Schedule background publication as well as computation.
- Use memory as evidence about retained structure.
- Preserve rich fallback paths around a common deterministic fast path.
- Treat benchmark integrity and terminal correctness as part of performance engineering.
