# Autoresearch: syntax highlighting startup latency

## Objective
Reduce the delay before syntax highlighting visibly appears when `hunk` starts, especially on larger multi-file diffs.

The benchmark targets the real app startup path. It now measures from **before importing `App`** until the selected file visibly paints highlighted emphasis spans in the terminal output. That means module load, app mount, and the first highlighted repaint are all included in the metric.

## Metrics
- **Primary**: `selected_highlight_ms` (ms, lower is better)
- **Secondary**: `iterations`, `samples`, `files`, `lines_per_file`

## How to Run
`./autoresearch.sh` — runs three cold-process app-startup benchmark samples and prints averaged `METRIC name=value` lines.

## Files in Scope
- `src/ui/diff/pierre.ts` — syntax highlight loading helpers and startup queueing.
- `src/ui/diff/PierreDiffView.tsx` — per-file highlight loading and render behavior.
- `src/ui/App.tsx` — real app startup flow, selection, and pane mounting.
- `test/app-syntax-highlight-startup-benchmark.ts` — synthetic app-startup benchmark workload.
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
- On the earlier helper-level benchmark, the biggest wins came from switching to the Shiki wasm engine, preparing only the active appearance theme, serializing startup highlight work with a lean promise chain, and caching Pierre highlighter options per appearance/language.
- On the earlier app-mount-only benchmark, small wins came from a plain-span fast path before highlighted HAST arrived and from kicking off highlight loading in a layout effect.
- A module-load warmup was rejected because the previous benchmark started after imports; the new benchmark includes import time so future warmup experiments can be measured honestly.
- This benchmark definition changed again, so a fresh baseline is required before further optimization.
