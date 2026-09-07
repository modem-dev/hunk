# Source architecture

This is the current maintainer map for ownership and import direction. Use it when adding a module
or deciding where an existing responsibility belongs. See [module boundaries](module-boundaries.md)
for executable rules and migration history.

## Workspace ownership

| Path                                  | Ownership                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/hunk/`                      | Published `hunkdiff` CLI, application, and the `hunkdiff/extension` and `hunkdiff/opentui` entrypoints |
| `packages/hunk-vcs/`                  | Private, dependency-bottom VCS helpers exposed through explicit `@hunk/vcs/*` leaves                   |
| `packages/hunk-{git,jj,sapling}/`     | Private bundled VCS providers; each owns its commands, source interpretation, and provider tests       |
| `packages/session-broker-core/`       | Low-level broker envelopes, parsing, limits, and in-memory state                                       |
| `packages/session-broker/`            | Runtime-neutral broker, daemon, authentication, and connection lifecycle                               |
| `packages/session-broker-{bun,node}/` | Bun and Node listener adapters for the runtime-neutral broker                                          |
| `packages/term-video/`                | Private terminal capture and video composition tooling                                                 |
| `website/`                            | Astro/Starlight product and documentation site; it is not the browser review client                    |
| `scripts/`, `test/`, `docs/`          | Repository-wide automation, cross-boundary tests, and maintainer documentation                         |

Of the checked-in workspaces, only `hunkdiff` is published. Release automation also generates the
public `hunkdiff-{platform}-{arch}` binary packages from the matrix in
`scripts/packaging/prebuilt-package-helpers.ts`. Provider, VCS helper, broker, and term-video workspaces remain
private.

## Hunk source ownership

| Path                                | Ownership                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/hunk/src/app/`            | CLI parsing, startup plans, executable composition, and shared session bootstrap                               |
| `packages/hunk/src/app/review/`     | Review publication, resource caching, chunking, and producer-side protocol projection                          |
| `packages/hunk/src/app/session/`    | Mounted review runtime, registration, bridge, and reload authorization                                         |
| `packages/hunk/src/core/`           | Product models, non-rendering runtime primitives, and policy without a narrower owner                          |
| `packages/hunk/src/core/changeset/` | Changeset model and acquisition: loaders, per-file construction, sidecars, sources, and hunk formatting        |
| `packages/hunk/src/core/history/`   | Provider-neutral revision graph and lane planning                                                              |
| `packages/hunk/src/core/install/`   | Install channel, release lookup, updater, and installed-version policy                                         |
| `packages/hunk/src/core/run/`       | Command inputs, layered configuration, command catalog, user-facing errors, paths, and version                 |
| `packages/hunk/src/core/process/`   | TTY capabilities, pager/stdout, job control/relaunch, project-root discovery, persisted app state, and notices |
| `packages/hunk/src/core/review/`    | Ordered review document, identities, state, intents, reducer, selectors, and shared derivations                |
| `packages/hunk/src/core/theme/`     | Bundled theme metadata, custom-theme rules, and terminal theme detection                                       |
| `packages/hunk/src/core/watch/`     | Input signatures, observation plans/backends, and refresh coordination                                         |
| `packages/hunk/src/core/vcs/`       | Provider-neutral VCS catalog, contracts, operation dispatch, and host support                                  |
| `packages/hunk/src/extensions/`     | Extension host, registries, trust, lifecycle, and bundled registration adapters                                |
| `packages/hunk/src/session/`        | Shared session protocol, schemas, agent surface, and broker transport                                          |
| `packages/hunk/src/session/client/` | Session-daemon HTTP and compatibility clients                                                                  |
| `packages/hunk/src/session/agent/`  | Agent-facing session CLI, command manifest, errors, and formatting                                             |
| `packages/hunk/src/session/broker/` | Hunk daemon transport, launcher, broker state, wire parsing, and projections                                   |
| `packages/hunk/src/ui/`             | Interactive review application, terminal rendering, interaction, and chrome                                    |
| `packages/hunk/src/ui/history/`     | History surface and provider cursor lifecycle                                                                  |
| `packages/hunk/src/ui/log/`         | Log rendering and presentation helpers                                                                         |
| `packages/hunk/src/ui/session/`     | One OpenTUI renderer/root lifetime and the history/review surface router                                       |
| `packages/hunk/src/extension-api/`  | Public, import-free `hunkdiff/extension` declaration and runtime boundary                                      |
| `packages/hunk/src/opentui/`        | Public `hunkdiff/opentui` component boundary                                                                   |
| `packages/hunk/src/lib/`            | Small product-wide utilities with no feature owner                                                             |

`app/` composes subsystems but does not own terminal rendering. `core/` is the shared product layer,
not a bucket for everything outside React. Prefer a specific existing owner over `lib/`.

## Runtime flow

```text
packages/hunk/src/main.tsx
  -> app/startup.ts prepares a lazy StartupPlan
     -> app/cli.ts parses the invocation
     -> headless/history plan returned to main.tsx for dispatch, or
     -> app plan: app/extensionBootstrap.ts loads user extensions and reconciles root/config
        -> app/sessionBootstrap.ts selects VCS and loads one Changeset
        -> main.tsx lazy-loads ui/runInteractiveApp.tsx
           -> HunkSessionHost routes history and review in one React root
           -> AppHost owns reload, extension adoption, and review publication ordering
           -> App owns review interaction and layout coordination
           -> pane/diff modules plan, window, and paint terminal rows with Pierre metadata
```

All review inputs normalize to `Changeset` / `DiffFile[]`. Shared semantic review behavior follows:

```text
DiffFile[] -> projectReviewDocument -> ReviewDocumentV1 -> ReviewStore
ReviewIntent + caller facts -> planReviewIntent -> ReviewAction[] -> reducer -> projection
```

Terminal, agent/session, producer, broker, protocol, extension, and HTTP/SSE consumers reuse that
path. The browser client and UI remain planned.

## Dependency direction

- `main.tsx` and UI entry adapters perform final runtime and surface composition.
- `app` may compose `core`, `extensions`, and `session`; it must not import `ui`.
- `ui` may consume `core` and `extensions`. Only the composition shell and named adapters in
  `UI_SESSION_ADAPTERS` may import `app` or `session`; ordinary UI modules may not.
- `extensions` may consume provider-neutral core contracts. Renderer access is limited to the
  bundled UI boundary under `extensions/default/ui/`.
- Bundled provider packages may import provider-local modules, platform built-ins,
  `hunkdiff/extension`, and explicit `@hunk/vcs/*` leaves. They do not import Hunk core, app,
  session, UI, or generic `packages/hunk/src/lib` modules.
- `@hunk/vcs` imports no other workspace package and has no root export.
- `core` must not import `ui`, `app`, `session`, `extensions`, or `opentui`. Its narrow imports
  from the lower, import-free `extension-api` contract are explicit in the boundary rules.
- `extension-api/types.ts` stays import-free. `opentui` deliberately re-exports selected UI/core
  pieces as a public facade; neither public directory is a general internal bucket.
- Standalone workspaces do not reach into `packages/hunk/src` except through explicitly allowed
  public/provider contracts.

`bun run deps:check` applies `.dependency-cruiser.cjs` to every package and to Hunk's internal tiers.
`scripts/quality/source-boundaries.test.ts` adds browser-safe review and provider checks. The
executable rules take precedence over this summary.

## Bootstrap and lifecycle

Initial review launch and reload use `app/sessionBootstrap.ts` for extension-aware VCS selection,
changeset loading, changeset transforms, and session theme/config state. Callers retain lifecycle
work such as extension discovery, notices, and mounted UI state.

`ui/runInteractiveApp.tsx` owns the renderer, extension session, review runtime, and ordered cleanup.
`HunkSessionHost` routes history and review while retaining one `ExtensionSession`; that session owns
user-extension registry authority and retirement. `AppHost` owns review reload serialization,
content loading, broker publication, React commit, and post-layout event ordering. History closes
its provider cursor before extension shutdown.

Bundled Git, Jujutsu, and Sapling implementations register through the public extension contract in
`extensions/default/vcs/index.ts`. `app/vcsCatalog.ts` composes those registrations into the
provider-neutral catalog; `app/sessionBootstrap.ts` extends it with accepted user adapters. Bundled
providers remain active under `--no-extensions`.

## Boundary changes

When moving ownership:

1. Move a cohesive responsibility with its tests and update all consumers in the same change.
2. Remove replaced paths instead of retaining parallel implementations.
3. Keep public exports stable unless the change explicitly updates the public contract.
4. Update this map, `.dependency-cruiser.cjs`, and the relevant feature architecture document.
5. Run `bun run deps:check`; never add a known violation to avoid completing the move.

## Related documents

- [Module boundaries](module-boundaries.md) — executable import model and historical migration record
- [Extension architecture](extension-architecture.md) — current extension host and lifecycle design
- [Extension guide](extensions.md) — current public extension API and examples
- [Session broker SDK](session-broker-sdk.md) — normative future public SDK contract; current packages remain private
- [Browser review rebuild](browser-review-rebuild.md) — rollout plan and current browser boundary
- [Browser review seam audit](browser-review-seam-audit.md) — finding-level status and conformance record
