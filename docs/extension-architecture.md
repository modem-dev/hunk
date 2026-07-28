# Extension system architecture

Maintainer-facing map of how the extension system hangs together. The
authoring guide for extension users is [docs/extensions.md](extensions.md);
this doc is about Hunk's own internals. Each module named here carries a
header comment with the full local story — read those for depth; this page
exists so you know which module owns what.

## Tiers and loading

Extensions come in two tiers running through the same per-extension API
object and registry collection (`src/extensions/runExtension.ts`):

- **User extensions** load at interactive-app startup, before
  `loadAppBootstrap` (`src/extensions/startup.ts`, `src/extensions/host.ts`).
  Discovery groups and trust gating: `src/extensions/discovery.ts`,
  `src/extensions/trust.ts`.
- **Bundled extensions** live in `src/extensions/default/` and are compiled
  into the binary. `default/vcs/{git,jujutsu,sapling}` is statically imported
  and loaded synchronously _from VCS adapter resolution_
  (`default/vcs/index.ts`), so backends exist during config resolution — that
  load path must stay renderer-free. `default/ui/sidebar/` is deliberately not
  part of that list: it is UI code, loaded through `getBundledSidebarView`
  where the app resolves its sidebar views.

There are zero core-registered VCS adapters and no private sidebar: Git and
the built-in file navigation register through the public `registerVcsAdapter`
and `registerSidebarView` like any extension. That dogfooding is the honesty
mechanism — Git exercises every VCS integration point, the bundled sidebar
consumes exactly the public sidebar props, so a gap in the published contract
breaks Hunk's own code first.

Bundled extensions are implicitly trusted and stay loaded under
`--no-extensions`, which governs user extensions only.

## One registry, one apply path

Registrations (themes, file languages, VCS adapters, changeset transforms,
sidebar views, commands, lifecycle events) collect into one
`ExtensionRegistry` (`src/extensions/types.ts`) and are resolved/applied
through `src/extensions/apply.ts` on both startup and reload. A factory that
throws is rolled back to its pre-run registration counts
(`runExtension.ts`); failures cost a warning, not the session.

## Host-served runtime modules

Extension files import `react`, `@opentui/*`, and `hunkdiff/extension` as
host-served runtime modules (`src/extensions/hostRuntimeModules.ts`): a
per-extension-directory Bun loader hook transpiles extension source and
rewrites those specifiers to prefixed virtual modules backed by the host's
own instances. That identity is what lets `registerSidebarView` components
render inside the app's React tree with working hooks. The module header
documents why the obvious alternatives don't work (process-wide specifier
claims break the host's lazy imports; the loaders resolve lazily so headless
commands never pay OpenTUI's native-library extraction).

## Sidebar system

Sidebar registration is additive: any number of views, placed left or right
of the review stream, open/closed per view, `replacesDefault` to stand in
for the bundled file navigation. `src/ui/lib/sidebarPanes.ts` is the pane
model — session view list, open-state reconciliation across reloads, and the
layout plan deciding which open panes fit at what width.
`src/ui/components/panes/ExtensionSidebarPane.tsx` mounts one view: frozen
file views in, guarded actions out, error boundary scoped to the
registration identity.

## Command system

Every app-level keyboard shortcut is a named command in one dispatch table
(`src/ui/lib/appCommands.ts`); modal surfaces (dialogs, menus, focused
inputs) own their keys first and are deliberately not commands. Extension
`registerCommand` entries join the same table via
`src/ui/lib/extensionCommands.ts` — built-ins win key conflicts, detected by
probing matchers with a synthesized event (`src/lib/commandKeys.ts`).
Command handlers receive sidebar open/close controls, which is how a
registered key opens an extension's sidebar.

## VCS adapters

`src/core/vcs/index.ts` is the single assembly point ordering bundled + user
adapters by `detectionPriority` (Git is the baseline at 0; jj 200 / sl 100
sit above it for colocated checkouts — the constants in
`src/extension-api/types.ts` document the reasoning). Detection is uniform
across tiers: nearest checkout wins, priority breaks equal-distance ties, an
explicit `vcs` id a loaded backend owns beats detection
(`src/extensions/apply.ts`). `src/extensions/vcsPatchResult.ts` is the one
conversion boundary where a published `ExtensionVcsPatchResult` becomes
Hunk's internal diff model — anything a backend needs that cannot be
expressed publicly is a real gap in the contract.

## Public contract rules

The authoring surface is the `hunkdiff/extension` export — a façade over
internal types, declared in `src/extension-api/types.ts`. That module must
stay import-free: declaration emission ships every module the entry reaches,
so an import there publishes Hunk internals (`scripts/check-pack.ts` fails
the pack when it does, and typechecks every `docs/extensions.md` example as
a consumer). Shapes shared with internal code are declared there and
re-exported inward.
