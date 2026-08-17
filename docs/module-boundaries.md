# Module boundaries

Defines the target import boundaries between Hunk's top-level source trees and records what the
dependency graph actually looks like today. The boundaries are enforced by
[dependency-cruiser](https://github.com/sverweij/dependency-cruiser) over the production import
graph (`src/` plus `packages/`, tests excluded):

- `bun run deps:check` — fails CI on any boundary violation not in the baseline.
- `bun run deps:baseline` — regenerates `.dependency-cruiser-known-violations.json` after fixing
  a violation. The baseline is **shrink-only**: entries leave when the underlying edge is fixed,
  and nothing is ever added. New code must respect the boundaries from day one.
- Rules live in `.dependency-cruiser.cjs`; each rule's comment states the boundary it protects.

`scripts/source-boundaries.test.ts` remains the deeper, hand-authored gate for the review seam
(browser-safe closure, Node-debt tombstones). The dependency-cruiser rules are the coarse
tier-level complement, with real module resolution instead of regex import scanning.

## Target architecture

Tiers, bottom to top. A tier may import anything strictly below it and nothing above it:

```text
src/extension-api      published contract; imports nothing
src/lib                dependency-free helpers; may import extension-api only
src/core               domain model (changesets, review, vcs catalog, config)
packages/*             standalone publishable units (session broker, term-video);
                       never import src/
src/extensions         extension host + bundled extensions; consume core, never surfaces
src/session            daemon/broker transport + protocol; consumes core and packages
src/app                startup composition: CLI parsing plus the wiring of core,
                       extensions, and the session broker; no rendering
src/ui                 terminal surface; only the composition shell (App, AppHost,
                       runInteractiveApp), the named session adapter hooks
                       (useTerminalReview, useHunkSessionBridge), and their shared
                       navigation helper (ui/lib/reviewState) may import app/session
src/opentui            published facade re-exporting ui/core pieces for `hunkdiff/opentui`
src/main.tsx           CLI entry
```

Intentional exceptions, allowed by the rules:

- `src/opentui` imports `src/ui` internals: it is a packaging facade whose job is re-export.
- `src/hunk-review` imports `src/session/agent`: the skill document is generated from the agent
  surface by design.
- Tests are excluded: they are colocated and free to reach across boundaries.

## Module interiors

Tier rules say which trees may reach each other; interior rules say which _files_ in a tree
outsiders may name. A module's interior is enforced the same way as a tier — one rule per
protected file, `from` everything outside the module's directory, `to` the file — so an
accidental reach-in fails `bun run deps:check` instead of quietly becoming API.

Two supporting rules keep the interiors honest:

- **`no-dead-modules`** flags any module under `src/` that no entry point reaches
  (`main.tsx`, `highlightWorkerEntry.ts`, the `opentui` and `extension-api` facades, and the
  skill generator). It uses `reachable: false` rather than `orphan`, which only catches fully
  disconnected files and so misses dead code that still imports. A hit is deleted, or — when
  tests are its only genuine consumer — listed in the rule's `TEST_ONLY_MODULES` allowlist
  with the reason. That allowlist is **shrink-only**, like the baseline.
- **`core-leaves-never-reimport-types`** freezes the cycle fix below: the leaves extracted out
  of `core/types.ts` may never import it back, even though it re-exports them.

Phase 0 (2026-08-17) established the mechanism: it deleted `core/review/address.ts` (a
speculative primitive with no consumers), added the two rules above, and froze the first
interior — `core/review/reducer.ts` is importable only from within `core/review/`, because
callers state intent and `planReviewIntent` owns the transition. Later phases extend the same
pattern across `src/core` as its subdirectories take shape; the review model's named modules
(`document`, `identity`, `geometry`, `state`, …) stay public by design.

## Snapshot (2026-08-17, v0.19.0)

331 production modules, 1282 internal edges, **zero boundary violations and zero import
cycles** — the baseline is empty. The initial audit (2026-08-16) found 28 violations in five
clusters and 5 file-level cycles; all were repaid in the same change series that introduced the
rules:

- **Cycles.** Each cycle was a type-only back-edge from a lower module into a grab-bag above
  it. The cuts: `core/types.ts` gave its changeset model to `core/changeset.ts` and its
  command-input model to `core/commandInputs.ts` (re-exported from `core/types` so import
  sites keep working); the diff row model moved to `ui/diff/diffRowModel.ts`; the worker's
  compact encoder was retyped structurally (`HighlightedHastLines`); `HunkSessionBrokerClient`
  moved beside the client class it aliases; `CopySelectedRowRange` moved into
  `ui/lib/diffSpatial.ts`; `extensions/notifications.ts` now imports `ExtensionNotifyType`
  from its declaring module.
- **`src/core/cli.ts` → `src/app/cli.ts`.** CLI parsing that registers every tier's command
  surface (including `hunk session *` from `session/agent/surface.ts`) is composition, not
  domain — moving it made the core→session edges legal app→session edges.
- **`src/session/app/` → `src/app/session/`.** The mounted-review registration, bridge, and
  reload-authorization modules compose the app process with the session broker, and nothing
  inside `src/session` imported them — they were app-tier code homed on the wrong side.
  Moving the directory removed every session→app edge at once.
- **`src/lib/reviewDigest.ts` → `src/core/reviewDigest.ts`.** The Node digest implementation
  is review-semantic and platform-bound; core root (Node-full, outside the platform-free
  `core/review/` seam) is its tier.
- **`ui/lib/reviewState.ts`** resolves session-daemon navigation for the adapter hooks and is
  now a named entry in the adapter allowlist rather than an accidental reach-in.
- **The bundled sidebar's `src/ui` imports are documented design, not debt.** Its module
  header defines the dogfooding boundary as the published props contract (data, actions,
  theme); rendering helpers are host code. The rules now encode exactly that:
  `src/extensions/default/ui/` may consume `src/ui`, and still may never touch
  `src/app`/`src/session`.

## After the baseline: next targets

The tier rules now hold with no exceptions. Two follow-ups are worth doing next:

1. **Give `src/core` an interior.** _Started (phase 0, see Module interiors)._ The
   subdirectories (`review/`, `vcs/`, `theme/`, `watch/`, `patch/`) are already coherent
   modules; the ~40 loose files at `core/*` root are the grab-bag. Group them by audience
   (changeset model, config/CLI, process/runtime concerns) and then add per-module rules
   restricting which files other tiers may import — the review seam's named modules
   (`document`, `geometry`, `state`, …) stay public; their helpers become internal.
2. **Tighten the adapter allowlist.** `ui-couples-to-session-via-adapters` currently allowlists
   six files. As session coupling consolidates into `useTerminalReview` /
   `useHunkSessionBridge`, shrink the list.
