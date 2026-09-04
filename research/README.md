# Research

This directory preserves bounded engineering experiments that inform Hunk without becoming product
code by default.

Research entries are historical evidence, not supported APIs, release artifacts, benchmarks that
apply to every machine, or approval to ship their treatments. Each entry must state its status and
base revision, distinguish observations from conclusions, document material limitations, and provide
checksums for retained artifacts.

A completed entry should contain:

- `README.md` — status, hypothesis, outcome, and navigation;
- `plan.md` — the experiment's frozen scope and decision gates;
- `report.md` — results, limitations, and adoption decision;
- `artifacts/` — selected reconstruction and measurement evidence with a manifest.

Treatment implementations should remain isolated from `src/` and `packages/` in the archival change.
Prefer a reconstructable patch over merging discarded dependencies or runtime code. Exclude secrets,
credentials, bulky generated bundles, and redundant logs.

An experiment may be reconsidered only through a new plan with new evidence. Editing an old report
must not silently turn a discarded treatment into an accepted design.
