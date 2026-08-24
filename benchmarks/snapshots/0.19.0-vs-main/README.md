# 0.19.0 vs main benchmark snapshot

Ad-hoc A/B evidence captured for the 0.20.0 announcement. These files are **not** release-gate
baselines — `benchmarks/release/bench-x.y.z.json` remains the only input to `bun run bench:release:compare`.

Both snapshots were produced on one machine in the same sitting, alternating sides between rounds, and
each pools nine samples per metric (three rounds of three). `base-0.19.0.json` was built from a worktree
at tag `v0.19.0` (`44e16f6d`); `head-main.json` from `main` at `f4aa18b6`.

They are committed so the published numbers stay auditable. See
`docs/release-benchmark-0.19.0-vs-main.md` for the method, the verified results, and the caveats.
