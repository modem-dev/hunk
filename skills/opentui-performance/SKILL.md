---
name: opentui-performance
description: Profiles and optimizes React/OpenTUI terminal applications across first-frame latency, keyboard and mouse interaction, scrolling, layout, async workers, rendering, and retained memory. Use when an OpenTUI app feels slow, stutters during navigation or scrolling, renders large lists, consumes excess memory, or needs trustworthy performance benchmarks without correctness regressions.
compatibility: Designed for OpenTUI applications, especially React renderers on Bun; adapt commands and runtime-specific advice to the installed versions.
---

# OpenTUI performance engineering

Optimize the user's complete interaction path, not one framework layer or one flattering metric.
Treat correctness, terminal geometry, readiness, tail latency, and memory as constraints on every
experiment.

## 1. Establish the contract

Before editing, record:

- the exact user action that feels slow;
- the fixture shape: item count, content size, terminal dimensions, wrapping, and layout;
- what must be visible and ready when timing stops;
- the primary latency metric and secondary p95/memory/readiness metrics;
- product behavior that cannot change.

Separate these questions instead of combining them into one stopwatch:

1. process/bootstrap time;
2. first correct plain frame;
3. first fully ready frame, including async styling or data;
4. settled keyboard/mouse interaction;
5. interaction while background work is active;
6. warm/cache-hit behavior;
7. retained memory and cleanup.

Do not call an interaction faster merely because work moved past the measurement boundary.

## 2. Read the actual stack

Inspect the repository instructions, package versions, renderer setup, benchmark harness, and tests.
Then inspect the installed OpenTUI React host configuration and relevant core renderables. Do not
assume a JSX element is virtual or cheap: spans, boxes, and text nodes may become persistent host
objects with layout, dirtying, and lifecycle costs.

Trace the hot action end to end:

```text
input event
  -> semantic state transition
  -> React reconciliation
  -> OpenTUI host mutations
  -> Yoga/layout and text-buffer work
  -> terminal paint
```

Classify observed cost as semantic derivation, React work, host-renderable churn, layout, text
measurement, native/WASM paint, I/O, worker computation, worker-result publication, or garbage
collection. Use evidence rather than guessing.

See [rendering and geometry](references/rendering-and-geometry.md) for the renderer path and
[async work and memory](references/async-and-memory.md) for background work.

## 3. Build a trustworthy baseline

Prefer deterministic fixtures that assert visible output as well as timing. Run independent samples
in fresh processes so module caches, workers, renderer state, and heap history do not leak between
runs. Preserve raw samples and runtime metadata.

For decisions:

- report median and p95, plus absolute deltas;
- use at least five samples, and nine for noisy or borderline changes;
- remember that low-sample p95 is effectively a maximum;
- record RSS and heap at meaningful lifecycle points;
- compare equivalent runtime, platform, terminal dimensions, fixture, and feature eligibility.

Read [benchmarking and validation](references/benchmarking-and-validation.md) before creating or
changing a benchmark.

## 4. Reduce structure before caching

Investigate in this order:

1. eliminate unnecessary work;
2. create fewer React and OpenTUI objects;
3. shrink invalidation boundaries without adding more host renderables;
4. virtualize/window content with exact geometry;
5. stabilize hot props, actions, and keys;
6. schedule CPU and result publication away from interaction;
7. cache only the remaining proven work.

For already flattened, fixed-geometry text, consider passing `StyledText` directly instead of
building a React span forest. Keep expressive fallback paths for wrapping, selection, links,
editing, or other cases that need the text-node hierarchy. Measure: direct chunks are a technique,
not a universal rule.

## 5. Plan geometry once

Prefer this architecture for large terminal surfaces:

```text
domain data
  -> immutable item/row plan
  -> deterministic geometry
  -> section and item windows
  -> paint-only projection
```

Measurement, rendering, reveal, hit testing, and scrolling must consume the same plan. Replace
windowed content with exact-height spacers; keep selected and reveal targets mounted explicitly.
Use sorted geometry and binary search for visible bounds. Separate paint-only state from anything
that changes height or ordering.

Use bounded adaptive overscan: tight during slow movement, temporarily wider during wheel/page
bursts. Do not mount neighboring sections merely to prefetch their data.

## 6. Make identity a performance contract

For every hot memoized component, inspect whether parents recreate callbacks, arrays, maps, themes,
bounds, row objects, or keys. Stabilize capability objects with latest-value refs when semantics
allow it. Reuse previous objects when values are unchanged. Prefer shallow comparators backed by
immutable upstream data over deep comparisons.

Remount only at real host-geometry boundaries. Preserve the scroll container when possible; remount
an inner content root only when OpenTUI must recompute culling or layout assumptions.

## 7. Schedule background work and publication

Moving CPU work to a worker is only half of the job:

```text
worker computes
  -> result transfers
  -> state/cache changes
  -> plans rebuild
  -> terminal repaints
```

Use explicit versioned request protocols, ids, bounded concurrency, failure draining, disposal, and
compact transferable output. Deduplicate completed and in-flight work. Prioritize selected and
visible targets above adjacent and speculative halo work. Cancel, supersede, or deprioritize stale
queued jobs.

Ask when completed work should become visible. A result committed during wheel or key input can
still damage p95. Cache completion immediately when appropriate, but consider publishing cosmetic
results after active input settles. Measure the readiness cost explicitly; never hide it.

## 8. Run controlled experiments

Change one seam at a time. For every experiment record:

- hypothesis and expected affected phase;
- primary and secondary metrics;
- correctness checks;
- retained memory impact;
- complexity introduced;
- keep/discard decision and residual risk.

Reject optimizations that blank output, shrink fixtures without justification, disable styling,
skip settling while claiming readiness, compare ineligible feature paths, report only the best
sample, or move work outside the timer.

Use the [Hunk case study](references/hunk-case-study.md) for examples of structural wins, discarded
micro-optimizations, and worker tradeoffs. Its numbers are evidence from one application, not
universal thresholds.

## 9. Validate terminal reality

Use a ladder appropriate to the change:

1. pure plan/geometry/cache tests;
2. OpenTUI test renderer with correctness assertions;
3. PTY interaction tests for keyboard, mouse, resize, and scrolling;
4. real-TTY transcript smoke;
5. platform-specific CI and worker/package checks;
6. manual verification when rendering changed materially.

Include CJK, emoji, combining characters, tabs, ANSI/control sanitization, horizontal clipping,
wrapping, resize, and pathological long lines when relevant. A fast misaligned or blank frame is a
failure.

## 10. Report the result

Return a reviewable performance report:

```markdown
## Workload and environment

## Baseline

## Profile evidence

## Experiments and raw sample summary

## Retained changes

## Regressions and tradeoffs

## Correctness and terminal validation

## Memory impact

## Residual risks
```

Lead with user-perceptible effects. Distinguish framework time from complete event-to-paint wall
time, and distinguish plain visibility from full readiness.
