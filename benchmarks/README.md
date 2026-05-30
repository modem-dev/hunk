# Benchmarks

Benchmark scripts, shared fixtures, and local result artifacts live here. These benchmarks protect Hunk's core promise: fast loading, fast first render, fast navigation, and predictable memory use on large diffs.

## Running locally

Run the full benchmark suite with one JSON result file:

```bash
bun run bench -- --samples 3 --out benchmarks/results/head.json
```

Run focused scripts while iterating:

```bash
bun run bench:bootstrap-load
bun run bench:working-tree-load
bun run bench:changeset-parse
bun run bench:render-layout
bun run bench:highlight-prefetch
bun run bench:large-stream
bun run bench:large-stream-profile
bun run bench:memory
bun run bench:competitors
```

Compare two JSON result files:

```bash
bun run bench:compare -- \
  --base benchmarks/results/base.json \
  --head benchmarks/results/head.json \
  --markdown benchmarks/results/summary.md
```

## Scripts

- `bootstrap-load.ts` — measures bootstrap and git-loader cost on a synthetic large repo, including file-pair bootstrap.
- `working-tree-load.ts` — measures git working-tree loads across small, medium, large, many-untracked, and few-large-untracked repos.
- `changeset-parse.ts` — measures patch normalization, Pierre parsing, patch chunking, and normalized `DiffFile` construction for many-small-files, balanced, and large-single-file patches.
- `render-layout.ts` — measures pure split/stack row building, section geometry, and review-plan construction for many-small-files, balanced, and large-single-file streams.
- `highlight-prefetch.ts` — measures selected-file highlight startup and adjacent prefetch readiness.
- `large-stream.ts` — measures large split-stream first-frame and scroll cost.
- `large-stream-profile.ts` — optional local profiler for the main pure planning stages behind the large split-stream benchmark.
- `memory.ts` — optional local RSS/heap profiler after fixture loading, planning, first frame, and next-hunk navigation.
- `competitors.ts` — optional local informational comparisons against `git diff --no-ext-diff`, `delta`, `difftastic`, and `diff-so-fancy` when installed.
- `large-stream-fixture.ts` and `lib/fixtures.ts` — shared deterministic synthetic fixtures.

## Output format

Each script prints `METRIC name=value` lines. `benchmarks/run.ts` repeats scripts, aggregates samples, and writes JSON:

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

## CI policy

`.github/workflows/benchmarks.yml` runs the suite on `main`, pull requests, and manual dispatch. On pull requests it:

1. Runs benchmarks on the PR revision.
2. Checks out `origin/main` in a sibling worktree.
3. Copies the PR benchmark harness into that base worktree so new benchmarks can compare base code during the PR that introduces them.
4. Runs the same benchmarks on base.
5. Compares medians and marks regressions in the PR summary without blocking the PR.
6. Uploads raw JSON/text artifacts.
7. Posts or updates one PR comment with a curated key-benchmark table, always including regressions and hiding noisy supporting metrics.

The default CI suite intentionally excludes optional memory profiling, pure-planning profiling, and competitor comparisons to keep PR feedback fast. Pull requests use one sample per benchmark and are informational/non-blocking; `main` runs keep three samples for a more stable history. Run `bun run bench -- --include-competitors` or focused scripts locally when deeper diagnostics are needed.

Initial thresholds:

- Time metrics (`*_ms`): fail when PR median is more than 15% slower **and** at least 5ms slower.
- Memory metrics (`rss`/`heap`): fail when PR median is more than 20% higher **and** at least 8MiB higher.
- Counts, fixture sizes, availability flags, and optional competitor metrics are informational.

Competitor comparisons are intentionally non-failing because installed tool versions and feature parity vary by environment.

## Updating thresholds

Prefer fixing regressions first. If a maintainer accepts an intentional tradeoff, update the threshold in `benchmarks/lib/benchmark-result.ts` and mention why in the PR. Keep thresholds broad enough for CI variability but tight enough to catch visible slowdowns.

## Noise troubleshooting

- Re-run failed jobs before investigating tiny deltas; thresholds include absolute tolerances to avoid failing on sub-5ms noise.
- PTY/renderer-adjacent metrics are noisier than pure parsing/planning metrics.
- Use `--samples 5` locally when validating borderline changes.
- Inspect uploaded raw samples before changing thresholds.
