# Autoresearch: syntax highlighting startup latency

## Objective
Reduce the delay before syntax highlighting appears when `hunk` starts, especially on larger multi-file diffs.

The target is the startup path that mounts many `PierreDiffView` instances and asynchronously loads highlighted diff output. We want the first visible highlighted diff to appear sooner without regressing eventual correctness or changing the product behavior.

## Metrics
- **Primary**: `selected_highlight_ms` (ms, lower is better)
- **Secondary**: `all_highlights_ms`, `samples`, `files`, `lines_per_file`

## How to Run
`./autoresearch.sh` — runs three cold-process benchmark samples and prints averaged `METRIC name=value` lines.

## Files in Scope
- `src/ui/diff/pierre.ts` — syntax highlight loading helpers and startup queueing.
- `src/ui/diff/PierreDiffView.tsx` — per-file highlight loading and render behavior.
- `test/syntax-highlight-startup-benchmark.ts` — synthetic cold-start benchmark workload.
- `autoresearch.sh` — benchmark entrypoint.
- `autoresearch.checks.sh` — correctness backpressure.

## Off Limits
- Major dependency changes.
- Replacing Pierre diffs.
- Removing syntax highlighting.
- Product behavior changes beyond making startup highlighting faster.

## Constraints
- All tests must pass.
- Keep syntax highlighting support intact.
- Do not cheat or overfit the benchmark.
- Preserve the current diff model and renderer architecture.

## What's Been Tried
- Initial single-sample baseline: `selected_highlight_ms=2381.47`.
- Reusing a per-language in-flight highlighter-preparation promise improved the single-sample startup metric slightly to `2349.96ms`.
- Queueing startup highlight rendering in arrival order produced the first large win, cutting the single-sample selected-file metric to `1065.82ms` while keeping total completion time roughly flat.
- Raising highlight-render concurrency from 1 to 2 regressed the selected-file metric to `1437.34ms`, so the current best keeps a single queued startup highlight job.
- The benchmark now averages three cold-process runs. Current 3-run baseline on the kept queueing strategy: `selected_highlight_ms=1054.11`.
- Removing the extra microtask hop from the queued highlight job regressed badly (`2349.21ms` average), so the current best keeps the queued async handoff.
