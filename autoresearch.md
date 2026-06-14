# Autoresearch: SolidJS fork benchmark performance

## Objective

Optimize the `migrate/solidjs-opentui` SolidJS port so the default benchmark suite is faster than the React implementation on `origin/main`, while preserving behavior and tests. The branch already renders correctly and typechecks, but measured regressions include hunk-navigation latency and retained heap after navigation.

## Metrics

- **Primary**: `perf_score` (unitless, lower is better) — sum of positive comparable median regressions versus the frozen React-main baseline, scaled by 1000. A score of `0` means every comparable benchmark metric is at least as fast/low-memory as the baseline in this local run.
- **Secondary**: `worst_ratio`, `regressions_count`, `material_regressions_count`, `geomean_ratio`, plus focused Solid/UI metrics like hunk navigation latency, scroll latency, first-frame time, and navigation heap ratio.

## How to Run

`./autoresearch.sh`

The script runs the default benchmark suite (`bun run bench -- --samples 3`) against this branch, compares medians to `autoresearch.baseline.react-main.json`, and emits `METRIC name=value` lines.

## Files in Scope

- `src/ui/**/*.ts`, `src/ui/**/*.tsx` — app state, review controller, diff planning/rendering, Solid-facing UI hooks and components.
- `src/opentui/**/*.ts`, `src/opentui/**/*.tsx` — package exports and OpenTUI/Solid diff components.
- `patches/@opentui%2Fsolid@0.1.89.patch` — local Solid renderer fixes or performance patches when the bottleneck is in the adapter.
- `benchmarks/**/*.ts` — benchmark diagnostics only; do not weaken, skip, or cheat benchmark workloads.
- `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig*.json` — only if needed for legitimate Solid/OpenTUI performance plumbing.
- `autoresearch.*` — local experiment harness and notes.

## Off Limits

- Do not delete tests, skip tests, reduce benchmark fixture sizes, lower benchmark sample counts to claim a win, or remove user-visible behavior.
- Do not switch the main renderer away from Pierre-backed rendering.
- Do not change the benchmark suite to hide Solid regressions. Benchmark edits are allowed only to add diagnostics or fix measurement bugs, and must be documented.
- Do not optimize solely for fixture constants in ways that would harm real diffs.

## Constraints

- Preserve the current interaction model, layout behavior, sidebars, hunk navigation, mouse/keyboard parity, and agent-note behavior.
- `bun run typecheck` must pass for kept changes; run broader tests when touching non-trivial behavior.
- Prefer reusable model/planning improvements over ad hoc duplicate UI paths.
- Primary metric is relative to the frozen local React-main baseline captured from `origin/main` at `3906f39` with 3 samples on this machine.

## What's Been Tried

- Setup captured `origin/main` React baseline into `autoresearch.baseline.react-main.json` and created a comparison harness.
- Initial hypothesis from migration report: Solid reduces steady-state scroll latency but regresses `interaction-latency/hunk_nav_press_*` and `after_navigation_heap_used_bytes`, likely from reactive graph/update churn around selection/navigation or repeated row tree creation.
- Kept: split `useReviewController` review-state memos so file lists, sidebar entries, and hunk cursors no longer rebuild on every selected hunk change. This improved `perf_score` ~15% and reduced navigation heap.
- Kept: use Solid `createSelector` for selected-hunk row styling in `PierreDiffView`. This was the biggest win so far, cutting worst-ratio tail scroll regressions and avoiding every mounted row subscribing directly to hunk-index changes.
- Kept: trim selected-hunk reveal retries from `[0, 16, 48]` to `[0]`. This reduced timer churn and improved hunk-nav median/p95 plus navigation heap while preserving benchmarked reveal behavior.
- Discarded: lowering viewport read coalescing to `0` or `8` ms. It improved some large-stream timing but worsened non-ASCII scroll tails and primary score; keep the 16ms coalescing.
- Discarded: selected-file `createSelector`, explicit `batch()` in `selectHunk`, visible-bounds DOM lookup skipping, note-map pre-scan, smaller highlight halo, smaller row overscan, file-id maps, row-color Map caches, and precomputed hover callbacks. These mostly added reactive dependencies or allocation overhead that outweighed their theoretical wins.
