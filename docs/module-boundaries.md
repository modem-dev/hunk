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
src/app                startup composition: wires core + extensions + session; no rendering
src/ui                 terminal surface; only the composition shell (App, AppHost,
                       runInteractiveApp) and the named session adapter hooks
                       (useTerminalReview, useHunkSessionBridge) may import app/session
src/opentui            published facade re-exporting ui/core pieces for `hunkdiff/opentui`
src/main.tsx           CLI entry
```

Intentional exceptions, allowed by the rules:

- `src/opentui` imports `src/ui` internals: it is a packaging facade whose job is re-export.
- `src/hunk-review` imports `src/session/agent`: the skill document is generated from the agent
  surface by design.
- Tests are excluded: they are colocated and free to reach across boundaries.

## Snapshot (2026-08-16, v0.19.0)

310 production modules, 1161 internal edges. The good news first: the graph is broadly layered
already — `src/app` never imports `src/ui`, packages are standalone, `src/extension-api` is
import-free, and file-level cycles are few and small. The problems are concentrated, not
diffuse:

- **`src/core` has no interior.** 58 of its 69 files are imported from outside — an 84% public
  surface. It behaves as a shared file pool, not a module.
- **`src/core/types.ts` is a god module**: 91 inbound edges (next highest: 44), imported by
  every tier, and itself a member of the largest import cycle.
- **28 boundary violations** (the baseline), in five clusters described below.
- **5 import cycles** (2–6 files each).

## Baseline violations and how to repay them

Grouped by cluster, roughly in suggested order of attack.

### 1. Small upward edges (cheap, high signal)

- `src/core/cli.ts → src/session/agent/{surface,errors}` — the CLI help text embeds the agent
  surface docs. Invert: let the session tier register its command documentation into a catalog
  `core/cli.ts` renders, or move the agent-facing CLI assembly up beside `src/app`.
- `src/lib/reviewDigest.ts → src/core/review/validation.ts` — review-semantic code sitting in
  the helper tier. Move it into `src/core/review/` (its one non-core consumer already imports
  core freely).
- `src/ui/lib/reviewState.ts → src/session/agent/errors.ts` and `session/types` — a UI helper
  reaching into session error formatting. Either promote `reviewState.ts` to the adapter
  allowlist deliberately, or (better) move the shared error catalog down to core so both tiers
  consume it from below.

### 2. Bundled sidebar reaches into `src/ui` internals

`src/extensions/default/ui/sidebar/index.tsx` imports `FileListItem`, `ui/lib/files`,
`ui/lib/ids`, and `ui/lib/sidebarRenderWindow` directly. The bundled tier exists to dogfood the
public extension API; these four edges are exactly what a third-party extension cannot write.
Repay by promoting what the sidebar genuinely needs into the host-served runtime-module surface
(the same mechanism user extensions use), or by moving the shared pieces into a tree both may
import.

### 3. `src/session/app` ↔ `src/app/review` mutual dependency

`session/app/registration.ts` imports `app/review/{capability,publication}` (one runtime edge)
while `src/app` imports session brokering — the two tiers hold hands. `capability.ts` and
`publication.ts` are review-publication semantics, not startup composition; moving them into
`src/core/review/` (they are already close to `resources.ts`/`generationOrder.ts`) breaks the
mutual dependency without inventing a new tier. The remaining `session/app → app/review/producer`
edges are type-only and disappear once the producer's published types move with them.

### 4. Import cycles

| Cycle                                                                                            | Suggested cut                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/types ↔ core/vcs/{types,index} ↔ core/{diffFile,sidecar,watch/plan}` (6 files)             | Split `core/types.ts`: the changeset/diff model, the view-options/config types, and the VCS-facing types are three audiences. The cycle exists because everything lives in one file. |
| `ui/diff/{codeColumns,diffRows} ↔ ui/diff/worker/*` (5 files)                                    | The worker protocol types should be a leaf module both sides import; today the worker index re-imports the row model that imports it back.                                           |
| `session/{types,protocol} ↔ session/broker/brokerClient ↔ session/client/capabilities` (4 files) | Extract the wire-protocol types into a leaf (mirroring what `reviewProtocol.ts` already does for the review side).                                                                   |
| `ui/diff/{diffSectionGeometry,renderRows} ↔ ui/components/panes/copySelection` (3 files)         | `copySelection` is interaction policy importing geometry; geometry should not know it exists.                                                                                        |
| `extensions/types ↔ extensions/notifications` (2 files)                                          | Move the notification payload types into `extensions/types.ts` (or a shared leaf) so `types.ts` stops importing a sibling implementation.                                            |

### 5. Root-level stragglers

`src/highlightWorkerClient.ts` and `src/highlightWorkerEntry.ts` sit at the src root but belong
to `src/ui/diff/worker/` (the worker index imports back out to the root file). Fold them into
the worker directory, keeping only genuine bundler entry points at the root. Not encoded as a
rule yet; do it opportunistically.

## After the baseline is empty

Two follow-ups become worth doing once the tier rules hold:

1. **Give `src/core` an interior.** The subdirectories (`review/`, `vcs/`, `theme/`, `watch/`,
   `patch/`) are already coherent modules; the ~40 loose files at `core/*` root are the
   grab-bag. Group them by audience (changeset model, config/CLI, process/runtime concerns) and
   then add per-module rules restricting which files other tiers may import — the review seam's
   named modules (`document`, `geometry`, `state`, …) stay public; their helpers become
   internal.
2. **Tighten the adapter allowlist.** `ui-couples-to-session-via-adapters` currently allowlists
   five shell files. As session coupling consolidates into `useTerminalReview` /
   `useHunkSessionBridge`, shrink the list.
