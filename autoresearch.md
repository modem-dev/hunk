# Autoresearch: rendering and scroll performance

## Objective
Improve hunk's rendering and scroll responsiveness without changing visible behavior, interaction model, or major dependencies. Focus on the real review workload: a multi-file diff stream rendered through the current OpenTUI + Pierre stack. Measure performance in frames per second (fps) using a repeatable benchmark that exercises both mouse-wheel scrolling and hunk navigation in split and stack layouts.

## Metrics
- **Primary**: fps (higher is better)
- **Secondary**: split_scroll_fps, stack_scroll_fps, split_nav_fps, stack_nav_fps, benchmark_ms

## How to Run
`./autoresearch.sh` — runs `bun run test/render-scroll-benchmark.tsx` and prints `METRIC name=value` lines.

## Benchmark Workload
The benchmark builds a representative synthetic changeset with multiple TypeScript files, many hunks, long lines, and some agent annotations. It then:
1. warms the renderer/highlighter,
2. measures repeated mouse-wheel scroll repaints in split mode,
3. measures repeated mouse-wheel scroll repaints in stack mode,
4. measures repeated `]` hunk-navigation renders in split mode,
5. measures repeated `]` hunk-navigation renders in stack mode.

The primary fps is the harmonic mean of those four scenario fps values so a single weak interaction still hurts the score.

## Files in Scope
- `src/ui/App.tsx` — shell state, selection, layout, and pane coordination
- `src/ui/components/panes/DiffPane.tsx` — multi-file review stream container
- `src/ui/components/panes/DiffSection.tsx` — per-file diff section and header
- `src/ui/diff/PierreDiffView.tsx` — row rendering, note anchoring, and diff view composition
- `src/ui/diff/pierre.ts` — Pierre diff row construction and highlighting transforms
- `src/ui/lib/*.ts` — helper logic for diff/annotation/render derivations
- `test/*.tsx` / `test/*.ts` — regression coverage and benchmark harness
- `.hunk/latest.json` — refresh review notes after code changes (do not commit)

## Off Limits
- Major dependency changes or renderer swaps
- Switching away from Pierre-backed diff rendering
- Behavior changes to layout semantics, navigation semantics, or note placement
- Benchmark-specific shortcuts that would not help real app responsiveness

## Constraints
- Maintain existing behavior
- Do not change major dependencies such as OpenTUI or Pierre diffs
- Do not cheat or overfit to the benchmark
- Keep benchmark representative of real review usage
- Passing changes must also satisfy `autoresearch.checks.sh`

## What's Been Tried
- Session initialized with a new fps benchmark covering scroll and hunk navigation in both split and stack layouts.
- Memoized selected-file note derivation in `DiffPane`, memoized `DiffSection`, and memoized row work inside `PierreDiffView`. This sharply improved hunk-navigation throughput by avoiding whole-stream rerenders when only the selected hunk changes.
- A first attempt to memoize row bodies without changing row structure was effectively noise and did not beat the current best result.
- Reworked split/stack line cells to render gutter + content as inline text spans inside one box instead of separate gutter/content boxes. After restoring the original gutter spacing, this delivered a large win in both scroll and navigation fps while keeping tests green.
