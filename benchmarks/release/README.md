# Release benchmark snapshots

Committed files in this directory are the performance baselines used by the release workflow. They are intentionally versioned so a release can be audited after publishing.

## Release prep

Before pushing a release tag, run the benchmark suite for the version in `package.json`:

```bash
bun run bench:release
```

This writes:

```text
benchmarks/release/bench-x.y.z.json
```

Then compare it against the latest lower stable release snapshot:

```bash
bun run bench:release:compare
```

Commit the new `bench-x.y.z.json` file with the release-prep change. The tag release workflow validates that this file exists and fails before publishing npm packages if the comparison finds a material regression.

## Regression policy

The gate compares benchmark medians and only fails on regressions that exceed both the relative and absolute thresholds embedded in the benchmark result metadata:

- timing metrics: default `+15%` and at least `+5ms`
- memory metrics: default `+20%` and at least `+8MiB`

New metrics are informational until a later release has a baseline. Missing previously comparable metrics fail, because that means the gate can no longer protect that measurement.

## Backfilling

When adding this gate or restoring a missing baseline, check out the release tag and generate the snapshot with the same Bun version and runner class used for current release prep. Commit backfilled snapshots before relying on the release gate.
