# Benchmarks

Benchmark scripts, shared fixtures, and local result artifacts live here.

## Scripts

- `bootstrap-load.ts` — measures bootstrap and git-loader cost on a synthetic large repo
- `highlight-prefetch.ts` — measures selected-file highlight startup and adjacent prefetch readiness
- `large-stream.ts` — measures large split-stream first-frame and scroll cost, including note-enabled cases
- `large-stream-profile.ts` — profiles the main pure planning stages behind the large split-stream benchmark
- `large-stream-fixture.ts` — shared synthetic diff fixture used by the large-stream benchmarks

## Running

From the project root:

```bash
bun run bench:bootstrap-load
bun run bench:highlight-prefetch
bun run bench:large-stream
bun run bench:large-stream-profile
```

## Results

Use `benchmarks/results/` for local benchmark output, notes, or captured runs.

The folder stays in the repo so the convention is discoverable, but local result files inside it are ignored by default.
