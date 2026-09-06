# Source architecture

This is the maintainer map for source ownership and import direction. It complements
feature-specific documents such as [the extension architecture](extension-architecture.md).
Use it when adding a new module or deciding where an existing responsibility belongs.

## Ownership

```text
packages/hunk/src/app/             executable composition: CLI parsing, startup plans, and shared session bootstrap
packages/hunk/src/app/session/     mounted-review registration, bridge, and reload authorization
packages/hunk/src/core/            review model, patch handling, VCS contracts, configuration, and
                     runtime primitives
packages/hunk/src/core/changeset/  the changeset model and the pipeline that acquires one: loaders,
                     per-file construction, sidecar/source reads, and hunk formatting
packages/hunk/src/core/run/ how a run is asked for: command inputs, layered configuration, the
                     command catalog, user-facing errors, paths, and version
packages/hunk/src/core/process/    the process and terminal a run lives in: TTY capabilities, the pager,
                     job control, shutdown, project-root discovery, persisted app state,
                     and startup/update notices
packages/hunk/src/core/theme/      bundled theme metadata, custom-theme rules, and terminal theme detection
packages/hunk/src/core/watch/      input signatures, observation plans/backends, and refresh coordination
packages/hunk/src/core/vcs/        provider-neutral VCS catalog, contracts, operation dispatch, and host support
packages/hunk/src/extensions/      extension host, registry, trust, lifecycle, and bundled extensions
packages/hunk/src/session/         shared session protocol, schemas, types, agent surface, and broker transport
packages/hunk/src/session/client/  shared session-daemon HTTP and compatibility client support
packages/hunk/src/session/agent/   agent-facing session CLI, command manifest, errors, and formatting
packages/hunk/src/session/broker/  local daemon transport, launcher, Hunk broker state, wire parsing, projections
packages/hunk/src/ui/              interactive review application, rendering, interaction, and chrome
packages/hunk/src/extension-api/   public `hunkdiff/extension` declaration and runtime boundary
packages/hunk/src/opentui/         public `hunkdiff/opentui` component boundary
packages/hunk/src/lib/             small product-wide utilities with no feature ownership
```

`packages/hunk/src/app/` is intentionally small: it composes subsystems but does not become a second
application framework. `packages/hunk/src/core/` remains the shared product layer, not a synonym for
"anything outside React". Put a module in a more specific existing subdirectory whenever
one owns its behaviour.

## Dependency direction

- `app` may compose `core`, `extensions`, `session`, and `ui`.
- `ui` may consume core models and the extension/session contracts; it owns terminal rendering.
- `extensions` may consume provider-neutral core models and contracts, but bundled VCS provider
  implementations must depend only on `hunkdiff/extension`, local modules, and `packages/hunk/src/lib` utilities.
  Renderer access remains limited to `extensions/default/ui/`, the bundled-sidebar boundary.
- `core` must not import `ui` or `extensions`. Shared data needed by both belongs in core-owned
  structural contracts or `packages/hunk/src/lib`, never in a reverse dependency.
- `extension-api/types.ts` stays import-free. It is a published declaration boundary, enforced by
  the package checks.
- `opentui` and `extension-api` are public entrypoint directories, not general internal buckets.

`scripts/source-boundaries.test.ts` mechanically enforces `core -> ui`, `core -> extensions`,
and bundled-provider -> core boundaries, including the public extension-barrel requirement.

## Bootstrap invariant

Initial launch and live-session reload use `app/sessionBootstrap.ts`. That service is the one
place that applies extension registrations, resolves extension-aware VCS selection, loads the
normalized changeset, applies changeset transforms, and attaches session theme/config state.
Callers retain their distinct lifecycle work (terminal setup, extension rediscovery, notices,
and mounted-app state), but must not recreate this ordering.

## Migration policy

This is an incremental migration, not a bulk rename:

1. Move code only when a feature changes it or when a small cohesive cluster can move with its
   colocated tests.
2. Add the destination module and update all consumers in one change; do not maintain permanent
   duplicate implementations.
3. Keep product-visible import paths and public package exports stable.
4. Prefer a named ownership boundary over a generic `lib` folder.
5. Update this map and feature architecture docs when a boundary changes.

Current composition lives in `app/`: `app/vcsCatalog.ts` assembles bundled registrations into a
provider-neutral catalog, and `app/sessionBootstrap.ts` extends that catalog with user adapters.
Provider commands, source readers, and tests live under `extensions/default/vcs/<provider>/`.
