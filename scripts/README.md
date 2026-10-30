# Repository scripts

Scripts are grouped by the workflow they support. Prefer the stable `bun run` aliases in the root
`package.json` when one exists.

- `benchmarks/` — release and daemon benchmark tooling
- `build/` — source builds and local binary installation
- `dev/` — manual development probes and fixtures
- `generate/` — checked-in documentation, skill, changelog, and theme generation
- `launch-video/` — launch-video capture and composition
- `packaging/` — package assembly, validation, publication, and install checks
- `quality/` — repository architecture, package-contract, and example conformance tests
- `release/` — Changesets and release-channel validation
- `test/` — default test-suite and compatibility runners
- `website/` — website catalogs, helpers, and link checks

Keep tests next to the script or policy they cover.
