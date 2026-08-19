# Async work, workers, caches, and memory

Use this reference when expensive I/O, parsing, syntax highlighting, workers, prefetching, cache
retention, or delayed result publication affects interaction.

## Workers move computation, not publication

Model the whole pipeline:

```text
request
  -> input/source loading
  -> queue wait
  -> worker computation
  -> serialization/transfer
  -> validation/cache insertion
  -> React state publication
  -> plan rebuild/layout/paint
```

Measure at least:

- time to first correct plain frame;
- time to fully ready/styled frame;
- input latency while work is active;
- queue catch-up after rapid navigation;
- cost of applying a completed result;
- worker and main-process RSS/heap.

A worker can improve input p95 while making final styling later. Report both.

## Worker protocol checklist

Use an explicit protocol with:

- version number;
- unique request id;
- structured-clone-safe request and response types;
- success and failure variants;
- response validation;
- stale/unknown response rejection;
- deterministic cleanup on worker error.

On a fatal worker error, reject every active and queued promise. Do not leave callers hanging.
Provide a disposal path, and prevent background infrastructure from keeping short-lived commands
alive (`unref` where supported).

Feature-detect runtime and packaging support. A compiled binary, development process, Windows,
Linux, and macOS may resolve worker entrypoints differently. Degrade to a documented inline or plain
path rather than crashing the TUI.

## Bound concurrency and prioritize work

Unlimited concurrency can multiply highlighter/parser state, WASM heaps, serialization buffers, and
GC pressure. A serialized worker is predictable but creates head-of-line blocking.

Use explicit priorities:

1. selected destination;
2. currently visible work;
3. imminent navigation target;
4. adjacent work;
5. viewport halo;
6. speculative background work.

Allow a high-priority consumer to promote an already queued request. Consider cancellation or
supersession for requests that have not started. If active jobs cannot be interrupted, bound their
size so one obsolete task cannot block interaction for seconds.

Do not confuse React unmount cancellation with CPU cancellation: suppressing `setState` prevents a
stale commit but does not stop a worker or I/O request unless the underlying job receives an abort
signal or queue cancellation.

## Prefetch from geometry

Derive prefetch targets from navigation and viewport geometry, not component mount. Start data work
without mounting all of the corresponding UI.

Useful target groups:

- selected item;
- visible items;
- known next/previous target;
- a bounded viewport halo.

Keep prefetch policy separate from mount/window policy. A component should mount because it is
visible, overscanned, selected, or explicitly revealed—not merely because its data should become
warm.

## Deduplicate completed and in-flight work

Use both:

- a completed-result cache;
- a `Map<key, Promise<Result>>` for active work.

Every caller—prefetch and mounted consumer—should share the same promise. Remove an active promise
only if it is still the current promise for that key, so an older completion cannot delete a newer
request.

Do not cache transient worker failures as successful plain results if a later retry should be
possible.

## Cache identity

A safe key commonly includes:

- content digest or upstream version id;
- semantic item identity;
- theme/appearance;
- rendering options;
- source/provider identity;
- any grammar/parser configuration.

Prefer upstream content identities to hashing whole content on every render. If a provider has no
version key, object identity may be a process-local fallback, not a durable cross-reload identity.

Render should remain side-effect free. If LRU reads mutate recency, use a non-touching `peek` during
render and perform recency-changing reads in an effect or commit-safe phase.

## Budget by retained cost

Item-count limits are rarely sufficient. Estimate or measure:

- bytes in strings and typed arrays;
- row/cell count;
- fixed object overhead per entry;
- worker-side and main-side copies;
- transfer/cloning behavior.

Use byte- or work-bounded LRU caches. Charge empty entries and failures if they are retained, or a
watch/reload loop can leak keys for “zero-cost” values.

Choose and document oversized-entry behavior:

- reject it without evicting useful residents;
- allow one current oversized entry temporarily;
- render a reduced/plain representation;
- stream or page the result.

Typed-array transfer detaches buffers. A worker cache must clone retained payloads before transfer,
or transfer a one-shot oversized payload without pretending it remains cached. Avoid transiently
doubling very large buffers.

## Publish results deliberately

A completed result can still damage scroll or key p95 if publication rebuilds mounted rows during
input.

Options include:

- publish immediately for selected/visible semantic data;
- batch several cosmetic completions;
- retain the previous paint during an active wheel/key burst;
- publish the latest cached cosmetic result after a short idle interval;
- prewarm the worker so completion occurs before interaction begins.

Every deferral must be measured as readiness latency. Never call the app faster merely because
color, data, or layout appears after the timer stops.

React transitions and deferred values are not guaranteed solutions. External cache reads or native
host mutations can bypass React priority, and native paint may dominate. Verify them experimentally.

## Compact worker output

Return only what the terminal needs. Prefer compact runs, indexes, palettes, or typed arrays over
large AST/HAST/object graphs when practical. Validate all indexes and ranges before using them to
paint.

Compact output reduces:

- structured-clone cost;
- main-thread allocation;
- retained cache size;
- GC;
- transfer time.

Keep a parity test against the trusted inline implementation.

## Lazy and bounded I/O

Load expensive source/documents only when the feature needs them. Cap bytes before decoding or
retaining large inputs. Represent loading, unavailable, too-large, and error states explicitly.

Memoize resolved data where appropriate and deduplicate the in-flight first read; caching only the
resolved value can still duplicate simultaneous I/O.

Guard result commits with request id, content generation, provider identity, and side/key. A late
read from old content must not overwrite a reloaded session.

## Lifecycle ownership

The hook/module that creates a resource should own cleanup:

- unsubscribe observers;
- close watchers;
- clear timers;
- abort I/O;
- reject queued work;
- dispose workers in controlled tests or shutdown;
- suppress stale state commits after unmount or key change.

Use latest-value refs when callback changes should not recreate an expensive watcher or controller.

## Memory diagnostics

Record both:

- JavaScript heap used;
- process RSS, including native/WASM/worker effects.

Take snapshots after meaningful phases: fixture/bootstrap, planning, first frame, navigation,
resize, worker startup, and cleanup. Force GC only when comparing retained memory, and label that
fact.

For leak tests, run repeated realistic cycles, discard warmup, settle cleanup, then inspect total
growth and per-cycle slope. A lower JS heap with higher RSS may mean work moved into native or worker
memory rather than disappearing.

## Anti-patterns

- unbounded FIFO queues with obsolete speculative work;
- one worker per item;
- caching raw object graphs when compact output is sufficient;
- cache keys based only on array index or display position;
- starting async work during render;
- mounting UI solely to trigger prefetch;
- swallowing worker failure without settling callers;
- treating cancelled React commits as cancelled computation;
- reporting input latency without readiness and queue catch-up;
- using a threshold tuned to one grammar or line length as a universal constant.
