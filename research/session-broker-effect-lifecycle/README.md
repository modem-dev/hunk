# Session broker Effect lifecycle experiment

> **Status: discarded experiment — not production code and not approved for merge.**

This entry preserves a disposable comparison of the existing explicit TypeScript session-broker
lifecycle with a treatment built on exactly `effect@3.22.1`. It tested whether one process-owned
Effect runtime and Clock could simplify producer startup, launcher polling, connection handshake,
heartbeat, reconnect, and ordered shutdown without converting Hunk's security or domain core.

The experiment started from Hunk commit
`42d2b9dd2f3144e33080f159f4cc9c2824ad1708`. The treatment was intentionally stopped before daemon
and native-adapter migration.

## Outcome

The treatment removed the targeted native timing owners from the connection and client, but did not
make the lifecycle easier to audit. The decisive observations were:

- standalone Bun broker bundle: 90,116 to 331,670 bytes (`+268.0%`);
- compiled Hunk: `+622,592` bytes (`+0.35%`);
- lifecycle-ready median: 12.093 to 37.875 milliseconds (`+213.2%`);
- every retained isolated producer microbenchmark regressed;
- the treatment added 515 lines of lifecycle implementation and retained substantial manual
  Promise, wake, state, and fiber ownership;
- independent review found unresolved repeated starts, incorrect retained retry timing, incomplete
  lifecycle closure, failed restart after natural completion, and a pre-existing failed-connection
  retention path exposed by the experiment;
- the clean-install Bun linker workaround weakened reproducibility.

The decision was **discard Phase 1 and do not begin Phase 2**. The useful ideas are being pursued as
small plain-TypeScript changes: adversarial lifecycle tests, failed-connection rollback, explicit
startup states, a minimal clock seam, late-settlement fences, process-exit fixtures, and bounded
defect reporting.

## Contents

- [`plan.md`](./plan.md) records the hypothesis, boundaries, gates, and frozen control design.
- [`report.md`](./report.md) records measurements, validation, defects, limitations, and the final
  decision.
- [`artifacts/`](./artifacts/) contains selected control and treatment evidence plus reconstructable
  patches.

## Evidence boundary

The retained hashes establish consistency of these local artifacts. They do not establish signer
identity, a trusted timestamp, universal benchmark results, or production approval. Bulky compiled
bundles and redundant raw logs were omitted; their sizes and command results remain recorded in the
structured result files and original evidence manifests.

Verify the retained archive from the repository root:

```sh
sha256sum -c research/session-broker-effect-lifecycle/artifacts/MANIFEST.sha256
```
