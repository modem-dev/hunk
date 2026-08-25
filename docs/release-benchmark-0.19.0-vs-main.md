# Release benchmark: 0.19.0 vs main

Snapshot captured for the 0.20.0 announcement. Compares `v0.19.0` (`44e16f6d`) against `main`
(`f4aa18b6`), 26 commits apart.

Raw snapshots: `benchmarks/snapshots/0.19.0-vs-main/`.

## Method

The committed `benchmarks/release/bench-0.19.0.json` baseline was produced on a GitHub runner under
Bun 1.3.14. Diffing it against a local run would have measured the hardware rather than the code, so
both sides were rebuilt and re-run on one machine in the same sitting:

- A worktree at tag `v0.19.0` and the `main` checkout, each with its own `bun install --frozen-lockfile`.
- Three rounds alternating `base -> head`, three samples per side per round, so drift hits both sides
  equally. Nine samples per metric per side, pooled; medians taken over the pooled set.
- Bun 1.3.11, Linux x64, 4 cores, otherwise idle.

### Parity checks

Run before trusting any delta:

| Check                                                        | Result                                                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Default-suite benchmark scripts                              | Differ only by import-path refactors (`src/core/types` -> `src/core/changeset/model`); no fixture changes |
| `benchmarks/lib/` fixtures                                   | Byte-identical between trees                                                                              |
| Workload descriptors (file counts, line counts, patch bytes) | All 62 identical across both sides                                                                        |
| Runtime dependencies                                         | Identical; only a devDependency was added                                                                 |

The last row is what licenses the claim that these deltas are Hunk's own code rather than a dependency bump.

### Evidence bar

A metric is reported as a change only when **every** sample on `main` beat **every** sample on `0.19.0`.
Metrics whose sample ranges overlap are recorded as directional and not claimed. Sample sets that split
into two separated clusters are flagged bimodal and excluded from claims entirely, because their median
reports which cluster the run happened to land in.

## Verified results

Every head sample beat every base sample:

| Metric                                                 |    0.19.0 |    main |         Change |
| ------------------------------------------------------ | --------: | ------: | -------------: |
| `terminal-width/complex_cluster_text_width_ms`         | 1210.0 ms | 28.1 ms | **43x faster** |
| `interaction-latency/hunk_nav_press_median_ms`         |  150.7 ms | 91.1 ms |       **-40%** |
| `interaction-latency/after_navigation_rss_bytes`       |   432 MiB | 315 MiB |       **-27%** |
| `interaction-latency/after_navigation_heap_used_bytes` |   130 MiB |  98 MiB |       **-25%** |

The Unicode result is 4,000 measurements of ZWJ emoji sequences and combining diacritics, 302 us -> 7.0 us
each. `benchmarks/terminal-width.ts` asserts `measureTextWidth` against `string-width` per line and
compares checksums before timing, so the fast path is verified correct on every run. At 28.1 ms against
`string-width`'s 1160.7 ms on the same corpus, Hunk is 41x faster than the package it validates against.

### Directional, not claimed

Moved the right way, but sample ranges overlap at this sample count:

| Metric                                                  |  0.19.0 |    main | Change |
| ------------------------------------------------------- | ------: | ------: | -----: |
| `interaction-latency/scroll_tick_p95_ms`                | 44.0 ms | 22.3 ms |   -49% |
| `interaction-latency/after_first_frame_heap_used_bytes` |  41 MiB |  31 MiB |   -24% |

### Fast highlighting

The `--fast` offload (#810) is absent from every metric above, because the suite never enables the flag.
Measuring it from outside the process cannot see it either: offloading relocates highlighting to a worker
rather than removing it, so total CPU is flat whether or not the flag helps. Driving the shipped binary
through a PTY found only its cost -- RSS 240 -> 257 MiB, consistent across three rounds.

`bun run bench:fast-latency` toggles the flag through the bootstrap and measures in-app latency instead.
Three interleaved rounds, 18 samples per arm, on 0.20.0:

| | fast off | fast on | delta |
| --- | ---: | ---: | ---: |
| first frame | 29.6 ms | 12.3 ms | **-58%** |
| hunk-nav press, median | 76.7 ms | 43.8 ms | **-43%** |
| hunk-nav press, p95 | 225.6 ms | 85.0 ms | **-62%** |
| scroll tick, median | 12.2 ms | 8.3 ms | -32% |
| scroll tick, p95 | 64.6 ms | 37.8 ms | -42% |

Every row's bootstrap CI excludes zero. The flag roughly halves interaction latency for about 17 MiB, and
helps worst-case navigation most, which is what moving blocking work off the main thread should look like.
These are within-0.20.0 numbers: they say what the flag is worth, not what the release is worth.

## Attribution

| Result                        | Commit                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| Complex Unicode width         | `20c1295e` fix(ui): cache complex Unicode cluster widths (#800) |
| Navigation latency and memory | `dc66723b` perf(ui): reduce hunk navigation latency (#803)      |
| Highlight reuse               | `6c8cacf3` perf(diff): reuse evicted worker highlights (#791)   |

## Caveats

- 49 of 61 timing and memory metrics showed no reliable change. This is a targeted set of wins, not a
  uniform speedup.
- Six metrics have slower medians (`+5%` to `+18%`), all inside run-to-run noise; none trip the gate's
  `+15% and +5 ms` rule, and none separate from noise under the evidence bar above.
- Single machine and single Bun version. Absolute values will differ elsewhere; the ratios are the point.

## Memory, measured on the shipped binaries

Both tags were compiled with `bun run build:bin` and driven under a real PTY on the same 40-file /
4,800-line working-tree diff, stepping through 12 hunks with `]`, sampling the whole process tree.
Three interleaved rounds per side, after a warm-up run to avoid first-execution page-in:

|                                 |  0.19.0 |  0.20.0 |    delta |
| ------------------------------- | ------: | ------: | -------: |
| RSS after navigating            | 322 MiB | 239 MiB | **-26%** |
| Private (anon) after navigating | 273 MiB | 187 MiB | **-32%** |
| Peak RSS                        | 345 MiB | 272 MiB |     -21% |

Run-to-run spread is about +/-1 MiB and the two sides never overlap. These reproduce the suite's ratio
(-26% against -27%) from the shipped artifact, so the ratio is trustworthy even though the suite's
absolutes are not: it holds the synthetic fixture alongside the parsed model, runs under the OpenTUI
test renderer, and reads an RSS that never returns after a GC (destroying the renderer moved RSS
211 -> 208 MiB).

Scenario matters more than diff size. Opening the same diff _without_ navigating gives 204 -> 186 MiB
(-8.5%): most of the win is retained navigation state, not steady-state footprint. Diff size barely
moves the floor -- an 18x larger diff adds only ~43 MiB.

For context, same PTY harness, same repo, steady state:

| Tool                   |     RSS | private |
| ---------------------- | ------: | ------: |
| `git diff \| less`     |   9 MiB |   1 MiB |
| `vim`                  |  14 MiB |   6 MiB |
| `hunk` (40-file diff)  | 186 MiB | 133 MiB |
| Claude Code CLI (idle) | 354 MiB | 134 MiB |
| opencode (idle)        | 690 MiB | 580 MiB |

Consider whether `*_rss_bytes` should gate releases at all: RSS is sticky after GC and harness-inflated,
so it tracks the harness more than anything a user experiences. The heap metrics are closer to reality.

## Bimodal metrics break the release gate

Running `bun run bench:release:compare` over these two snapshots **fails**, on one metric:

```text
non-ascii-stream/non_ascii_scroll_tick_p95_ms  61.27 ms -> 114.19 ms  +86.4%
```

This is a false positive. Individual scroll ticks in `non-ascii-stream` land either around 30 ms or
around 130 ms, so a nine-sample median reports which mode the run fell into. A focused re-run at 16
samples per side:

|                  |   0.19.0 |           main |
| ---------------- | -------: | -------------: |
| median           |  84.0 ms | 24.7 ms (-71%) |
| fast-mode median |  36.3 ms |        21.3 ms |
| slow-mode median | 158.5 ms |       118.2 ms |
| slow-mode rate   |     8/16 |           5/16 |

`main` is faster in both modes and enters the slow mode less often. `non_ascii_cold_first_frame_ms` is
bimodal in the same way (roughly 12 ms against 45 ms).

Before cutting 0.20.0, either raise `HUNK_RELEASE_BENCHMARK_SAMPLES` for the release snapshot or stop
gating on these two p95 metrics. Otherwise the release gate will fail for a reason that is not real.
