# Module boundaries

Defines the target import boundaries between Hunk's top-level source trees and records what the
dependency graph actually looks like today. The boundaries are enforced by
[dependency-cruiser](https://github.com/sverweij/dependency-cruiser) over the production import
graph (`packages/hunk/src/` plus `packages/`, tests excluded):

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
packages/hunk/src/extension-api      published contract; imports nothing
packages/hunk/src/lib                dependency-free helpers; may import extension-api only
packages/hunk/src/core               domain model (changesets, review, vcs catalog, config)
packages/*             standalone publishable units (session broker, term-video);
                       never import packages/hunk/src/; the per-app broker contract is in
                       docs/session-broker-sdk.md
packages/hunk/src/extensions         extension host + bundled extensions; consume core, never surfaces
packages/hunk/src/session            daemon/broker transport + protocol; consumes core and packages
packages/hunk/src/app                startup composition: CLI parsing plus the wiring of core,
                       extensions, and the session broker; no rendering
packages/hunk/src/ui                 terminal surface; only the composition shell (App, AppHost,
                       runInteractiveApp), the named session adapter hooks
                       (useTerminalReview, useHunkSessionBridge), and their shared
                       navigation helper (ui/lib/reviewState) may import app/session
packages/hunk/src/opentui            published facade re-exporting ui/core pieces for `hunkdiff/opentui`
packages/hunk/src/main.tsx           CLI entry
```

Intentional exceptions, allowed by the rules:

- `packages/hunk/src/opentui` imports `packages/hunk/src/ui` internals: it is a packaging facade whose job is re-export.
- `packages/hunk/src/hunk-review` imports `packages/hunk/src/session/agent`: the skill document is generated from the agent
  surface by design.
- Tests are excluded: they are colocated and free to reach across boundaries.

## Module interiors

Tier rules say which trees may reach each other; interior rules say which _files_ in a tree
outsiders may name. A module's interior is enforced the same way as a tier — one rule per
protected file, `from` everything outside the module's directory, `to` the file — so an
accidental reach-in fails `bun run deps:check` instead of quietly becoming API.

Two supporting rules keep the interiors honest:

- **`no-dead-modules`** flags any module under `packages/hunk/src/` that no entry point reaches
  (`main.tsx`, `highlightWorkerEntry.ts`, the `opentui` and `extension-api` facades, and the
  skill generator). It uses `reachable: false` rather than `orphan`, which only catches fully
  disconnected files and so misses dead code that still imports. A hit is deleted, or — when
  tests are its only genuine consumer — listed in the rule's `TEST_ONLY_MODULES` allowlist
  with the reason. That allowlist is **shrink-only**, like the baseline.
- **`core-leaves-stay-below-bootstrap`** freezes the cycle fix below: `core/bootstrap.ts`
  composes the module directories to describe one launch, so none of them may import it back.
  (Through phase 3 this rule was `core-leaves-never-reimport-types` and guarded
  `core/types.ts`; phase 4 melted that shell and repointed the rule at what replaced it.)

Phase 0 (2026-08-17) established the mechanism: it deleted `core/review/address.ts` (a
speculative primitive with no consumers), added the two rules above, and froze the first
interior — `core/review/reducer.ts` is importable only from within `core/review/`, because
callers state intent and `planReviewIntent` owns the transition. Later phases extend the same
pattern across `packages/hunk/src/core` as its subdirectories take shape; the review model's named modules
(`document`, `identity`, `geometry`, `state`, …) stay public by design.

Phase 1 (2026-08-17) grouped the changeset model and its acquisition pipeline — twelve loose
files at `core/*` root — into `core/changeset/`, with the surface split enforced by
`changeset-internals-stay-in-module`:

- **Public:** `model` (the `Changeset` / `DiffFile` / `SidecarContext` shapes), `loaders`
  (every input source, plus the app bootstrap built around one), `diffFile`, `fileSource`,
  `fileLanguage`, `binary`, `diffPaths`, `hunkHeader`, `hunkSummary`.
- **Interior:** `fromPatch` turns patch text into the model and is reached through `loaders`;
  `fileLanguageLookup` is the only reader/writer of Pierre's process-global extension table
  and the import that drags in the diff engine; `sidecar` reads `--agent-context` as one step
  of acquiring a changeset.

The renames are path-only — `changeset.ts` → `changeset/model.ts`, `changesetLoaders.ts` →
`changeset/loaders.ts`, `changesetFromPatch.ts` → `changeset/fromPatch.ts`, the rest keep their
basenames — and no exported symbol changed. `core/types.ts` still re-exports the changeset and
sidecar shapes for legacy import sites (since phase 4: those sites name `changeset/model`
directly); it names `changeset/model`, which is public, so the interior rule needs no
exception. `core/patch/` stayed where it is: it was already coherent.

Phase 2 (2026-08-17) grouped **how a run is asked for** into `core/run/`: the command
inputs (`commandInputs`), the layered config resolver (`config`), the app command catalog
(`commandCatalog`), the invocation errors (`errors` — "a failure Hunk raises because of how it
was invoked"), launch-scoped experimental features (`experimental`), XDG/app paths (`paths`),
tab-width validation (`tabWidth`), reload eligibility (`inputReload`), and the CLI version
(`version`). The move is path-only; no exported symbol changed.

Every one of the nine is **public**: each has production importers outside the module, so this
phase adds no `run-internals-stay-in-module` rule. Its value is the grouping plus
extending the freeze: `core-leaves-never-reimport-types` now names
`core/run/commandInputs.ts` in place of the old root path. Only `commandInputs` is a
types-leaf — `config`, `experimental`, and `inputReload` import `core/types` legally, since
`core/types` re-exports from `commandInputs` and never the other way round. (Since phase 4
there is no shell to import: those three name `commandInputs` directly, and `config` declares
the config-owned shapes itself.)

`commandInputs` also absorbed the CLI-input half that was still declared in `core/types.ts`:
`HelpCommandInput`, `PagerCommandInput`, `DaemonServeCommandInput`, the whole
`Session*CommandInput` family with `SessionSelectorInput` / `SessionCommandOutput` /
`SessionCommentApplyItemInput`, `MarkupRenderCommandInput`, `MarkupGuideCommandInput`, the
`Extension*CommandInput` family, and `ParsedCliInput`. Two small aliases came with them because
those inputs name them and the leaf may not import `core/types` back:
`SessionCommentListType` and the `ReviewNoteSource` it unions over. `core/types.ts` re-exports
all of them, so no import site changed at the time; phase 4 moved the import sites onto
`commandInputs` and deleted the re-exports.

Phase 3 (2026-08-17) grouped **the process and terminal a run lives in** into `core/process/`:
TTY capability detection and runtime CLI-input resolution (`terminal`), the external pager and
its plain-text fallback (`pager`), SIGTSTP/SIGINT job control (`jobControl`), ordered session
teardown (`shutdown`), `.hunk`/VCS project-root discovery (`projectRoot`), the atomically
written app-state file (`appStateFile`), the version-check notice built on it (`updateNotice`),
and the startup-notice shape every tier reports through (`startupNotice`). The move is
path-only; no exported symbol changed, and `core/types.ts` now re-exports `StartupNotice` from
`process/startupNotice` (a re-export nothing ever imported, deleted unused in phase 4).

All eight are **public** — each has production importers outside the module — so this phase adds
no `process-internals-stay-in-module` rule; the grouping is its value. The audiences are worth
naming, because they are why these files never belonged at `core/*` root together with the review
model: `terminal`, `jobControl`, `shutdown`, and `updateNotice` serve the interactive surface;
`pager` serves the CLI entry and the startup plan; `projectRoot` and `appStateFile` serve the
extension host and config resolution.

After this phase `packages/hunk/src/core/` root holds only `types.ts`, `reviewDigest.ts`, and `liveComments.ts`
beside the seven subdirectories. Phase 4 melts what is left of `core/types.ts`.

Phase 4 (2026-08-17) melted that shell. `core/types.ts` had stopped declaring most of what it
exported: 147 files imported it, almost all for names phases 1–3 had already moved elsewhere,
and the re-export list was the only thing holding those import sites to a module that no longer
owned the answer. A grab-bag that re-exports is still a grab-bag — every importer binds to it,
so nothing downstream reveals which module it actually depends on.

Every import site was retargeted at the declaring module (mixed statements split one target per
module), the re-exports were deleted, and the file was renamed `core/types.ts` →
`core/bootstrap.ts` for what is genuinely left: `AppBootstrap` and `ReloadContext`, the contract
a composed launch hands the interactive shell. The stragglers it still declared went to the
module that owns their behaviour, one home each:

- `TerminalThemeMode` → `core/theme/detection.ts`, which probes the terminal for it and had
  been re-exporting the name from the shell.
- `ExtensionsConfig`, `UserKeyBinding`, `PersistedViewPreferences` → `core/run/config.ts`,
  which resolves `[extensions]`, `[keybindings]`, and the persisted view options.
- `UserNoteLineTarget` → `core/liveComments.ts`, beside `DiffSide` and `CommentTargetInput`: it
  is the line a user note hangs on, and every consumer reaches it through note code.

Deleting the re-exports made one hidden dependency visible: `core/review/annotations.ts` names
`AgentAnnotation`, which is declared in `packages/hunk/src/extension-api/types.ts` because it is
simultaneously an internal model type and part of the published contract. Routing that through
`core/types.ts` had disguised it as a core-local import, and `scripts/source-boundaries.test.ts`
("keeps the review model contained in core") caught it the moment the disguise came off. The
allowance is now explicit and narrow — that one file, not the tree — and it cannot widen the
seam, since `extension-api-is-import-free` forbids `extension-api/types.ts` any import at all.

Fan-in tells the story: 147 importing files became 28 (13 outside tests) — the review stream,
the diff renderer, and the session surfaces never needed the bootstrap contract, only the
changeset and command-input models they now name. `core/bootstrap.ts` imports downward into
`changeset/model`, `run/commandInputs`, `run/config`, `process/startupNotice`,
`theme/detection`, and `vcs/types`, and `core-leaves-stay-below-bootstrap` forbids the reverse
edge from every module directory. One exception is carved out and named in the rule:
`core/changeset/loaders.ts` returns an `AppBootstrap` from `loadAppBootstrap`, so it names the
shape it assembles; that function is composition living in the domain tier, and moving it to
`packages/hunk/src/app` retires the exception.

`packages/hunk/src/core/` root now holds `bootstrap.ts`, `reviewDigest.ts`, and `liveComments.ts` beside the
eight module directories.

Phase 5 (2026-08-18) grouped **how this binary was installed and how it gets replaced** into
`core/install/`: install-source detection (`installSource` — which channel owns the executable),
per-channel release lookup (`latestRelease`), and the `hunk update` execution (`selfUpdate`).
These arrived with the self-update feature as `core/process/` files because the startup update
notice lived there, but they are one feature family about the install lifecycle, not about the
process a run lives in. `process/updateNotice` stays where phase 3 put it — it is a
startup-notice producer built on `appStateFile` — and consumes `core/install` for detection and
release lookup. The move is path-only; no exported symbol changed.

## Snapshot (2026-08-17, v0.19.0)

331 production modules, 1322 internal edges, **zero boundary violations and zero import
cycles** — the baseline is empty. (The edge count grew from 1282 in phase 4: import sites that
used to funnel through one re-export shell now name the modules they actually depend on, so the
same dependencies are finally visible in the graph.) The initial audit (2026-08-16) found 28
violations in five
clusters and 5 file-level cycles; all were repaid in the same change series that introduced the
rules:

- **Cycles.** Each cycle was a type-only back-edge from a lower module into a grab-bag above
  it. The cuts: `core/types.ts` gave its changeset model to `core/changeset.ts` (since phase 1,
  `core/changeset/model.ts`) and its command-input model to `core/commandInputs.ts` (since phase
  2, `core/run/commandInputs.ts`; re-exported from `core/types` so import sites kept
  working, until phase 4 melted that shell into `core/bootstrap.ts` and moved the sites onto the
  declaring modules); the diff row model moved to
  `ui/diff/diffRowModel.ts`; the worker's
  compact encoder was retyped structurally (`HighlightedHastLines`); `HunkSessionBrokerClient`
  moved beside the client class it aliases; `CopySelectedRowRange` moved into
  `ui/lib/diffSpatial.ts`; `extensions/notifications.ts` now imports `ExtensionNotifyType`
  from its declaring module.
- **`packages/hunk/src/core/cli.ts` → `packages/hunk/src/app/cli.ts`.** CLI parsing that registers every tier's command
  surface (including `hunk session *` from `session/agent/surface.ts`) is composition, not
  domain — moving it made the core→session edges legal app→session edges.
- **`packages/hunk/src/session/app/` → `packages/hunk/src/app/session/`.** The mounted-review registration, bridge, and
  reload-authorization modules compose the app process with the session broker, and nothing
  inside `packages/hunk/src/session` imported them — they were app-tier code homed on the wrong side.
  Moving the directory removed every session→app edge at once.
- **`packages/hunk/src/lib/reviewDigest.ts` → `packages/hunk/src/core/reviewDigest.ts`.** The Node digest implementation
  is review-semantic and platform-bound; core root (Node-full, outside the platform-free
  `core/review/` seam) is its tier.
- **`ui/lib/reviewState.ts`** resolves session-daemon navigation for the adapter hooks and is
  now a named entry in the adapter allowlist rather than an accidental reach-in.
- **The bundled sidebar's `packages/hunk/src/ui` imports are documented design, not debt.** Its module
  header defines the dogfooding boundary as the published props contract (data, actions,
  theme); rendering helpers are host code. The rules now encode exactly that:
  `packages/hunk/src/extensions/default/ui/` may consume `packages/hunk/src/ui`, and still may never touch
  `packages/hunk/src/app`/`packages/hunk/src/session`.

## After the baseline: next targets

The tier rules now hold with no exceptions. Two follow-ups are worth doing next:

1. **Give `packages/hunk/src/core` an interior.** _Done (phases 0–4, see Module interiors)._ Every group is a
   module directory — `review/`, `vcs/`, `theme/`, `watch/`, `patch/`, `changeset/`,
   `run/`, `process/` — and `core/*` root is down to `bootstrap.ts`, `reviewDigest.ts`,
   and `liveComments.ts`, with no grab-bag left to import. What remains is per-file public
   surfaces for the modules that never got one: `changeset` has
   `changeset-internals-stay-in-module` and `review` has `review-reducer-is-module-internal`,
   while `run`, `process`, `theme`, `vcs`, `watch`, and `patch` are still public in full
   because every file in them has an outside importer today. Two named follow-ups: move
   `loadAppBootstrap` out of `core/changeset/loaders.ts` into `packages/hunk/src/app` (it is composition, and
   it is the one exception `core-leaves-stay-below-bootstrap` has to carve out), and split
   `core/run/config.ts`, whose readers reach it for three unrelated reasons — the
   resolved `HunkConfigResolution`, the persisted view preferences, and the extension/keybinding
   tables. The review seam's named modules (`document`, `geometry`, `state`, …) stay public;
   their helpers become internal.
2. **Tighten the adapter allowlist.** `ui-couples-to-session-via-adapters` currently allowlists
   six files. As session coupling consolidates into `useTerminalReview` /
   `useHunkSessionBridge`, shrink the list.
