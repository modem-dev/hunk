# Watch benchmark protocol

This campaign compares the polling base binary with the evented candidate binary. The portable fixtures are sanitized snapshots of Hunk (`little repo`) and modem (`big repo`); reports use only those two labels after this explanation. Campaign SHAs belong in the separately frozen campaign manifest, never in this tooling.

## Portable fixtures

Create each fixture from a local Git repository or bundle containing the exact frozen source commit and a currie-produced JSONL directory manifest. Each JSONL line is either a path string or `{ "path": "..." }`. The builder copies only committed Git objects from the selected snapshot. It does not copy remotes, credentials, ignored contents, or unrelated untracked files.

```sh
bun run benchmarks/watch/fixture.ts build \
  --source-git /path/to/source.bundle \
  --source-sha <frozen-full-sha> \
  --ignored-manifest /path/to/ignored-directories.jsonl \
  --label "little repo" --seed watch-v1 --scale 1 \
  --output /path/to/little-repo-artifacts

bun run benchmarks/watch/fixture.ts reconstruct \
  --artifacts /path/to/little-repo-artifacts \
  --repo /path/to/shared-fixture-checkout
```

The artifacts are `fixture.bundle`, `ignored-tree.jsonl.gz`, `fixture-manifest.json`, `fixture-summary.md`, and `checksums.sha256`. The deterministic orphan baseline commit uses `Hunk Benchmark <benchmark@hunk.invalid>` and `2000-01-01T00:00:00Z`. It adds `.hunk-benchmark/tracked.txt` and an ignore rule for `.hunk-benchmark-ignored/`. Reconstruction sets `core.autocrlf=false` and `core.symlinks=false` before checkout, so symlink blobs are materialized as plain files on every target OS.

The ignored manifest contains sanitized Windows-safe path components, not source names or contents. It preserves parent/child shape, depth, and fanout beneath `.hunk-benchmark-ignored/`. The fixture manifest and Markdown summary report:

- `totalSubdirectoryCount`: every directory below the checkout root except `.git` and its internals.
- `ignoredSubdirectoryCount`: the dedicated ignored root and every directory below it.
- `relevantSubdirectoryCount`: directories outside the dedicated ignored tree, excluding `.git`; therefore total equals ignored plus relevant.
- `trackedFileCount`, standardized initial `untrackedFileCount`, tracked symlink count/policy, and maximum depth.

Before every measured run, reset the same fixture path to its baseline, recreate the empty ignored tree, apply the standardized dirty tracked modification, and create the one standardized existing untracked file. Do not use separate base and candidate checkout paths. The asynchronous mutation helpers cover ordinary tracked writes, atomic temp-file renames over the tracked file, and relevant untracked creation. Pass an observer callback that awaits the UI refresh; each helper proves the authoritative Git signature changed, keeps the mutation in place through that callback, and restores the standard state afterward.

## Measurement cells

A cell is one binary and fixture pair at a fixed terminal geometry of **120 columns by 30 rows**. Base and candidate measurements must never run concurrently. Record the host OS/architecture, binary SHA, fixture manifest SHA256, stored campaign-order seed, trial/run number, deterministic order index, whether the sample is a warmup, and cache label in every raw result. Every result also repeats the fixture counts from `fixture-manifest.json`.

For each binary/fixture pair:

1. Reconstruct the fixture and capture one first-run result labeled **`cold-ish`**. This is a supplemental first-run observation, not a claim that OS or Git caches are truly cold.
2. Perform one unmeasured warmup, recorded with `warmup=true` and excluded from primary summaries.
3. Capture five primary warm-cache startup trials per revision as one 10-launch sequence. `startupLaunchOrder` deterministically selects `ABBA BAAB AB` or its exact mirror `BAAB ABBA BA` from the stored campaign-order seed, where A is base and B is candidate. Record the launch index and reset the shared fixture path between launches.
4. Capture two warm-cache idle runs of 120 seconds each. Run 1 uses `base,candidate`; run 2 uses `candidate,base`. Record cumulative CPU, memory, and Git-subprocess samples every 10 seconds. Preserve all 12 samples and report the exact samples through 60 seconds as the first-60-second slice, without interpolation.
5. Capture five warm-cache refresh-latency trials per mutation scenario when practical: ordinary tracked write, atomic rename over tracked content, and relevant untracked creation. If five are not practical, record the reason and the completed count rather than silently reducing it.

The primary comparison uses warm-cache measurements after the explicit warmup. Ordering is deterministic rather than concurrent so the two binaries do not contend for CPU, filesystem, or Git resources. The campaign is descriptive: it defines no performance pass/fail thresholds. Report raw samples and summary statistics without converting noise into a gate.
