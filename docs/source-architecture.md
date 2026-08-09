# Source architecture

This is the maintainer map for source ownership and import direction. It complements
feature-specific documents such as [the extension architecture](extension-architecture.md).
Use it when adding a new module or deciding where an existing responsibility belongs.

## Ownership

```text
src/app/             executable composition: startup plans and shared session bootstrap
src/core/            normalized review model, loading, patch handling, VCS contracts,
                     configuration, and runtime primitives
src/core/review/     versioned renderer-neutral review documents, semantic identity,
                     note policy, resources, and parity manifests
src/core/vcs/        provider-neutral VCS catalog, contracts, operation dispatch, and host support
src/extensions/      extension host, registry, trust, lifecycle, and bundled extensions
src/session/         shared session protocol, schemas, types, agent surface, app bridge, and broker transport
src/session/client/  shared session-daemon HTTP and compatibility client support
src/session/agent/   agent-facing session CLI, command manifest, errors, and formatting
src/session/app/     mounted-review registration, bridge, and reload authorization
src/session/broker/  local daemon transport, launcher, Hunk broker state, wire parsing, projections
src/ui/              interactive review application, rendering, interaction, and chrome
src/extension-api/   public `hunkdiff/extension` declaration and runtime boundary
src/opentui/         public `hunkdiff/opentui` component boundary
src/lib/             small product-wide utilities with no feature ownership
```

`src/app/` is intentionally small: it composes subsystems but does not become a second
application framework. `src/core/` remains the shared product layer, not a synonym for
"anything outside React". Put a module in a more specific existing subdirectory whenever
one owns its behaviour.

## Dependency direction

- `app` may compose `core`, `extensions`, `session`, and `ui`.
- `ui` may consume core models and the extension/session contracts; it owns terminal rendering.
- `extensions` may consume provider-neutral core models and contracts, but bundled VCS provider
  implementations must depend only on `hunkdiff/extension`, local modules, and `src/lib` utilities.
  Renderer access remains limited to `extensions/default/ui/`, the bundled-sidebar boundary.
- `core` must not import `ui` or `extensions`. Shared data needed by both belongs in core-owned
  structural contracts or `src/lib`, never in a reverse dependency.
- `extensions` may consume core model and VCS contracts, but must stay renderer-free except for
  `extensions/default/ui/`, which is the explicit bundled-sidebar boundary.
- `core` must not import `ui`. Shared data needed by both belongs in `core`, not `ui/lib`.
- `core/review` owns renderer-neutral document/identity/note policy. Terminal row insertion,
  note geometry, syntax-highlight spans, and deterministic STML line layout remain in `ui`.
- `extension-api/types.ts` stays import-free. It is a published declaration boundary, enforced by
  the package checks.
- `opentui` and `extension-api` are public entrypoint directories, not general internal buckets.

`scripts/source-boundaries.test.ts` mechanically enforces `core -> ui`, `core -> extensions`,
and bundled-provider -> core boundaries, including the public extension-barrel requirement.

## Review document invariant

The phased web-review boundary is described in
[the web review architecture](web-review-architecture.md). `ReviewDocumentV1` is initially a
serialization-safe projection of the normalized `Changeset`; it preserves exact stream order
and addresses patch/source bodies by generation without changing the terminal model. The review
process is authoritative. The loopback broker may mirror documents/state and proxy actions but
must not load repositories, run transforms, or derive note ownership.

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
