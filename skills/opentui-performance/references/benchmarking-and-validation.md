# Benchmarking and validation

Use this reference to build trustworthy performance evidence for an OpenTUI application.

## Start from the user promise

Name the exact interaction and completion condition. Useful independent metrics include:

- process/bootstrap latency;
- mount-to-first-correct-frame latency;
- first fully ready/styled frame;
- keypress median and p95;
- wheel/track/page-scroll median and p95;
- resize and wrap-settling latency;
- queue catch-up after rapid input;
- heap and RSS after first frame and interaction;
- cleanup growth/slope across repeated cycles.

Do not combine cold startup, async readiness, and settled interaction unless the product question
specifically combines them.

## Deterministic fixture matrix

Use multiple shapes because one aggregate size hides different costs:

- many small sections/items;
- balanced sections;
- one large section;
- giant/pathological item;
- fixed-height and wrapped content;
- ASCII and non-ASCII content;
- cold and warm cache/worker states;
- feature-ineligible and feature-eligible boundaries;
- mixed sizes that expose queueing and priority.

Keep unrelated dimensions fixed when sweeping one variable. For example, keep the visible changed
region constant while increasing full-source size to isolate syntax-highlighting cost.

Record fixture counts, line lengths, terminal dimensions, wrapping mode, theme, runtime version,
platform, architecture, and commit SHA.

## Correctness-bearing timing

Every timed scenario should also assert that:

- expected content is present;
- the frame is not blank;
- selection/navigation reached the intended target;
- scrolling moved the viewport;
- split columns or table cells remain aligned;
- wrapping did not clip required content;
- async styling/data eventually arrived;
- checksums or visible markers match the expected path.

A benchmark that gets faster by skipping output must fail.

## Fresh-process sampling

Independent samples should launch the benchmark script in a fresh process. This isolates:

- module and highlighter caches;
- singleton workers;
- React/OpenTUI renderer state;
- global promise maps and LRUs;
- heap/GC history;
- process-level native allocations.

Within one deliberate cold-versus-warm comparison, share a process and dispose renderers/workers in
`finally`.

A minimal output protocol is easy to aggregate:

```text
METRIC first_frame_ms=18.42
METRIC interaction_median_ms=7.11
METRIC interaction_p95_ms=11.84
METRIC heap_used_bytes=48123904
METRIC rss_bytes=272629760
METRIC correctness=1
```

Preserve raw samples in a machine-readable artifact.

## Percentiles and sample count

Report median plus p95, but interpret low-N tails honestly. With nearest-rank percentiles:

- three samples make p95 the maximum;
- five samples still make p95 the maximum;
- eight per-event samples make p95 the slowest event.

Use p95 as a tail diagnostic, not a statistically rich population estimate, unless sample count is
large. Run at least five fresh processes for clear effects and nine or more for noisy/borderline
changes. Alternate baseline/candidate order to reduce thermal and background-process bias.

Always report absolute deltas beside percentages. A 100% regression from 0.2 to 0.4 ms may be less
important than a 10% regression from 80 to 88 ms.

## Materiality

Use both a relative and absolute floor. Example policies:

```text
timing regression: >=15% and >=5 ms
memory regression: >=20% and >=8 MiB
```

Tune these to the product. Do not silently move thresholds after seeing a result. If a regression is
accepted, name the metric and record the product reason.

Secondary metrics can veto a primary win when they expose correctness, readiness, p95, or memory
harm. A median-only improvement is not automatically a product improvement.

## Interaction timing template

Adapt to the installed OpenTUI test utilities:

```ts
const latencies: number[] = [];
const keyUnderTest = "<interaction-key>";

for (let index = 0; index < presses; index += 1) {
  const start = performance.now();
  await act(async () => {
    await setup.mockInput.typeText(keyUnderTest);
    await setup.renderOnce();
    await Bun.sleep(0);
  });
  latencies.push(performance.now() - start);
}
```

Label what the timer includes. If timers, worker results, viewport synchronization, or rendering
settle later, either include them or report a separate readiness metric. Do not add sleeps merely to
manufacture a preferred boundary.

Use a fresh renderer when navigation and scrolling should be independent scenarios.

## Cold, settled, and warm states

A useful async benchmark reports:

1. first plain/usable frame;
2. selected item fully ready;
3. next target ready before movement;
4. one navigation input commit;
5. destination fully ready;
6. rapid input total;
7. final destination catch-up;
8. cache revisit.

For worker thresholds, sweep source sizes around each boundary and include mixed sizes. Once a
request is eligible, changing the numeric threshold usually does not alter worker behavior; it only
changes which files enter that path.

## Memory checkpoints

Use `process.memoryUsage()` for heap and RSS where available. For retained-memory comparisons, force
a full GC immediately before both snapshots and document it. For external long-lived processes,
prefer OS RSS/high-water metrics and repeated cycles.

Track phases such as:

```text
fixture loaded
plan built
first frame
worker started
navigation complete
resize complete
resources disposed
```

A falling heap paired with rising RSS may indicate native/WASM/worker migration. Report both.

## Profiling workflow

Use complementary evidence:

- React Profiler for component actual/commit duration;
- runtime CPU profiles for JS, native bindings, WASM, and buffer work;
- targeted instrumentation around input, plan building, layout, worker completion, and paint;
- mount/renderable counts;
- memory snapshots;
- controlled suppression experiments to isolate styling, selection paint, or async work.

Do not conclude “React is slow” when event-to-paint wall time greatly exceeds React commits.
Inspect the installed OpenTUI host config and core renderables when host mutation or text/layout work
is implicated.

## Terminal validation ladder

### Test renderer

Use for deterministic frames, spans, event dispatch, and profiling. Verify markers and geometry.

### PTY

Use a real child process and pseudoterminal for:

- keyboard routing;
- mouse wheel/click/drag;
- resize;
- focus and modal behavior;
- wide-character alignment;
- process readiness and clean exit.

Isolate configuration, plugins/extensions, notices, and daemon services. Poll observable state with a
deadline instead of sleeping a guessed duration. Always close processes and remove temporary files.

### Real TTY smoke

Use an actual terminal host/transcript tool where supported. Capability-probe Unix-only tools and
skip narrowly on unsupported platforms. Verify terminal takeover, rendering, interaction, and clean
restoration.

### Cross-platform

Compare benchmarks only on matching runtime/platform metadata. Exercise compiled worker resolution,
path handling, line endings, and terminal capability separately on Windows, macOS, and Linux.

## Unicode and pathological content

Include fixtures with:

- CJK wide cells;
- emoji and grapheme clusters;
- combining marks;
- box drawing;
- tabs crossing style boundaries;
- control and escape sequences;
- extremely long logical lines;
- hundreds of wrapped physical rows.

Assert terminal-cell alignment or width checksums, not merely JavaScript string length.

## Benchmark-integrity checklist

Reject a claimed improvement if it:

- changes the benchmark implementation without justification;
- shrinks the fixture or disables a feature;
- stops before required readiness;
- moves work onto an unmeasured timer;
- compares different eligibility paths unknowingly;
- includes warmed caches only on one side;
- reports the best sample instead of the distribution;
- ignores p95, memory, or correctness;
- measures redirected stdout when the product is an interactive TTY;
- leaves workers or renderers alive after the sample.

## Performance report template

```markdown
## Workload and environment

- Runtime / OpenTUI / React versions:
- Platform and terminal dimensions:
- Fixture:
- Completion condition:

## Baseline

| Metric | Median | p95 | Samples |

## Profile evidence

- React:
- Host/layout/native:
- Async/worker:
- Memory:

## Experiments

| Change | Primary | Secondary | Correctness | Decision |

## Retained changes

## Regressions and tradeoffs

## Validation

- Test renderer:
- PTY:
- TTY:
- Cross-platform:

## Residual risks
```
