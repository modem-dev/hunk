# Benchmarks

Benchmark scripts, shared fixtures, and local result artifacts live here. These benchmarks are local diagnostics for Hunk's core promise: fast loading, fast first render, fast navigation, and predictable memory use on large diffs.

## Running locally

Run the default local benchmark suite with one JSON result file:

```bash
bun run bench -- --samples 3 --out benchmarks/results/local.json
```

Run optional competitor comparisons when the tools are installed:

```bash
bun run bench -- --samples 3 --include-competitors --out benchmarks/results/local-with-competitors.json
```

Include the opt-in huge fixture tier (~1k files / 300k+ diff lines plus one ~50k-line file). A single huge sample can take minutes on the unoptimized hot path, so it is excluded from the default suite; enable it with the flag or `HUNK_BENCH_INCLUDE_HUGE=1`:

```bash
bun run bench -- --samples 1 --include-huge --out benchmarks/results/local-with-huge.json
```

Generate the committed release benchmark snapshot during release prep:

```bash
bun run bench:release
bun run bench:release:compare
```

Run focused scripts while iterating:

```bash
bun run bench:bootstrap-load
bun run bench:working-tree-load
bun run bench:changeset-parse
bun run bench:render-layout
bun run bench:highlight-prefetch
bun run bench:large-stream
bun run bench:interaction-latency
bun run bench:non-ascii-stream
bun run bench:huge-stream
bun run bench:large-stream-profile
bun run bench:memory
bun run bench:competitors
```

## Scripts

- `bootstrap-load.ts` — measures bootstrap and git-loader cost on a synthetic large repo, including file-pair bootstrap.
- `working-tree-load.ts` — measures git working-tree loads across small, medium, large, many-untracked, and few-large-untracked repos.
- `changeset-parse.ts` — measures patch normalization, Pierre parsing, patch chunking, and normalized `DiffFile` construction for many-small-files, balanced, and large-single-file patches.
- `render-layout.ts` — measures pure split/stack row building, section geometry, and review-plan construction for many-small-files, balanced, and large-single-file streams.
- `highlight-prefetch.ts` — measures selected-file highlight startup and adjacent prefetch readiness.
- `large-stream.ts` — measures large split-stream first-frame and scroll cost.
- `interaction-latency.ts` — measures per-press `]` hunk-navigation latency and per-scroll-tick latency (median + p95) on the large stream, plus RSS/heap ceilings after first frame and after navigation (the default-suite slice of `memory.ts`).
- `non-ascii-stream.ts` — measures first-frame and per-scroll-tick latency on a stream whose diff content embeds CJK, emoji, and box-drawing characters, exercising the string-width path on content rather than chrome glyphs.
- `huge-stream.ts` — opt-in huge tier (`--include-huge` or `HUNK_BENCH_INCLUDE_HUGE=1`): cold first frame, scroll-tick and hunk-navigation latency, and memory ceilings on ~1k files / 300k+ diff lines plus one giant ~50k-line file.
- `large-stream-profile.ts` — optional local profiler for the main pure planning stages behind the large split-stream benchmark.
- `memory.ts` — optional local RSS/heap profiler after fixture loading, planning, first frame, and next-hunk navigation.
- `competitors.ts` — optional local informational comparisons against `git diff --no-ext-diff`, `delta`, `difftastic`, and `diff-so-fancy` when installed.
- `large-stream-fixture.ts` and `lib/fixtures.ts` — shared deterministic synthetic fixtures.

## Output format

Each script prints `METRIC name=value` lines. `benchmarks/run.ts` repeats scripts, aggregates samples, prints a readable summary, and can write JSON:

```json
{
  "version": 1,
  "samplesPerBenchmark": 3,
  "results": [
    {
      "name": "large-stream/cold_first_frame_ms",
      "unit": "ms",
      "samples": [61.2, 60.8, 62.1],
      "median": 61.2,
      "p75": 62.1,
      "p95": 62.1,
      "threshold": {
        "maxRegressionRatio": 1.15,
        "minAbsoluteRegression": 5
      },
      "comparable": true
    }
  ]
}
```

## Notes

- These benchmarks are intentionally local-only for now. They are useful diagnostics, but CI proved too noisy and slow for PR gating.
- The default local suite excludes optional memory profiling, pure-planning profiling, the huge fixture tier, and competitor comparisons. Run those focused scripts when deeper diagnostics are needed.
- Fixture tiers: the moderate tier (180 files × 120 lines) backs `large-stream.ts` and `interaction-latency.ts`; the huge tier (1,000 files × 300 lines + one 50,000-line file) backs `huge-stream.ts` and is opt-in because one sample can take minutes before hot-path fixes land.
- Competitor comparisons are informational because installed tool versions and feature parity vary by environment.
- Use `--samples 5` locally when validating borderline changes.
- Use `benchmarks/results/` for local benchmark output; result files in that directory are ignored by default.
