# Selective extension control plan

## Status

Implemented in this branch for the shared selection model, configuration and CLI overrides,
`hunk.gh`, and user extensions (phases 1–3). Bundled VCS/UI selection and management commands
(phases 4–5) remain follow-up work; the stable ids below reserve their intended names without
claiming those factories are filtered yet.

## Goal

Let users disable or re-enable one Hunk extension without uninstalling it, including extensions
compiled into Hunk. Apply the decision before extension code executes, preserve the existing trust
model, and keep `--no-extensions` compatible with its current meaning.

The first bundled consumer is `hunk gh`, but the mechanism must also cover bundled VCS and UI
extensions and user-installed extensions without introducing feature-specific settings.

## Product decisions

### Stable selection identities

Give every independently selectable bundled extension a stable host-owned identity:

| Capability        | Selection ID       |
| ----------------- | ------------------ |
| GitHub commands   | `hunk.gh`          |
| Git provider      | `hunk.vcs.git`     |
| Jujutsu provider  | `hunk.vcs.jj`      |
| Sapling provider  | `hunk.vcs.sl`      |
| Content search    | `hunk.search`      |
| Files pane        | `hunk.files`       |
| Review-info panes | `hunk.review-info` |

User extensions keep their discovered IDs, such as `review-triage`.

A selection identity is not a registration namespace. Bundled UI registrations may continue to
own commands and panes under the `hunk` vendor namespace while being selected independently. This
avoids changing public command IDs such as `hunk.search.find` or pane IDs such as `hunk:files`.

### Configuration

Add an exact-ID deny-list to `[extensions]`:

```toml
[extensions]
enabled = true
disabled = ["hunk.gh", "hunk.search"]
paths = ["~/dev/my-extension"]
```

Keep the existing master switch:

```toml
[extensions]
enabled = false
```

`enabled = false` continues to disable user-extension discovery and loading. Bundled extensions
remain available unless selected by `disabled`.

Do not interpret `enabled` inside `[extension.<id>]`. Those tables remain opaque configuration
owned by the extension:

```toml
[extension.review-triage]
some_setting = true
```

Start with exact IDs rather than wildcard rules. Exact matching keeps diagnostics, layering, and
configuration editing deterministic. A future release can add patterns if concrete use cases
justify them.

### Configuration layering

Combine user and repository disabled lists as a union:

```text
effective disabled = user disabled ∪ repository disabled ∪ CLI disables
```

A repository may further restrict extension execution but cannot re-enable an extension disabled
by the user. This keeps repository-controlled configuration from escalating extension authority.

An explicit CLI enable is the only one-run override:

```text
effective enabled override = explicit CLI enables
```

Within CLI arguments, the last enable/disable occurrence for one identity wins.

### CLI overrides

Add repeatable global options:

```bash
hunk --disable-extension hunk.gh gh pr 123
hunk diff --disable-extension hunk.search
hunk diff --enable-extension hunk.search
```

Multiple identities can be selected:

```bash
hunk diff \
  --disable-extension hunk.search \
  --disable-extension review-triage
```

Keep `--no-extensions` as the hard one-run switch for user extensions. It does not disable bundled
extensions. An explicit `--extension <path>` still obeys the effective disabled set; pair it with
`--enable-extension <id>` to override a persistent disable deliberately.

### Management commands

Extend extension management with inspection and persistent state changes:

```bash
hunk extension list
hunk extension list --builtin
hunk extension list --all

hunk extension disable hunk.gh
hunk extension enable hunk.gh

hunk extension disable review-triage --repo
hunk extension enable review-triage --repo
```

The default mutation scope is the user config. `--repo` edits `.hunk/config.toml`. `remove` remains
limited to installed extensions; bundled extensions can be disabled but not removed.

List output should expose identity, source, and effective state:

```text
ID                    SOURCE      STATE
hunk.gh               bundled     disabled (user config)
hunk.search           bundled     enabled
hunk.vcs.git          bundled     enabled
review-triage         installed   disabled (repo config)
```

Config mutation must preserve unrelated TOML content and use the same serialization and atomic-write
policy as other Hunk-owned config updates. If no safe writer exists when this work begins, ship
read-only config plus one-run flags first and defer `extension enable/disable` rather than adding a
lossy editor.

### Disabled command diagnostics

Keep enough static bundled metadata to recognize a command owned by a disabled extension. Do not
report it as an unknown command:

```text
hunk: Extension "hunk.gh" is disabled.

Enable it for this run:
  hunk --enable-extension hunk.gh gh pr 123

Enable it permanently:
  hunk extension enable hunk.gh
```

Bare `hunk --help` remains static and may continue listing bundled commands. It should not load
configuration or extension code merely to annotate disabled entries.

### VCS providers

Allow bundled VCS providers to be disabled. Raw files and patches must continue to work without a
VCS provider. When repository detection finds only a disabled provider, report that provider and an
actionable one-run enable command:

```text
No enabled VCS provider recognizes this repository.

Disabled matching provider: hunk.vcs.jj
Enable it with:
  hunk --enable-extension hunk.vcs.jj diff
```

Do not model indispensable host machinery as an extension. Anything that cannot sensibly be
disabled should remain host code rather than receive a selectable identity.

## Architecture

### Bundled definition catalog

Introduce a renderer-free catalog of bundled extension definitions. Each definition carries:

```ts
interface BundledExtensionDefinition {
  selectionId: string;
  registrationId: string;
  sourcePath: string;
  kind: "core" | "vcs" | "ui";
  factory: ExtensionFactory;
  commands?: readonly string[];
}
```

`selectionId` controls enablement. `registrationId` preserves public command, pane, and config
namespaces. `commands` is bounded static metadata used only for disabled-command diagnostics; the
factory remains authoritative when enabled.

The catalog must not merge VCS, core CLI, and UI lifecycles. Existing composition owners continue
to create their own registries:

- bundled VCS loads before configuration-dependent repository resolution;
- bundled core CLI capabilities use the session-owned extension lifetime;
- bundled UI remains process-owned and renderer-local.

All three consume the same resolved selection policy before running factories.

### Selection policy

Add a small platform-free policy module that accepts:

- known bundled definitions;
- discovered user candidates;
- user-layer disabled IDs;
- repository-layer disabled IDs;
- ordered CLI enable/disable operations;
- the existing user-extension master switch.

It returns an immutable decision per identity with the reason and source:

```ts
interface ExtensionSelectionDecision {
  id: string;
  enabled: boolean;
  source: "default" | "user-config" | "repo-config" | "cli" | "master-switch";
}
```

Keep this policy separate from filesystem discovery, trust decisions, module imports, and registry
mutation. Callers apply decisions before import or factory execution.

### Loading order

For every startup path:

1. Resolve user and repository configuration.
2. Parse ordered CLI extension overrides.
3. Resolve bundled selection decisions.
4. Run only enabled bundled factories in their existing lifecycle owners.
5. Discover user candidates when the existing master switch permits it.
6. Resolve candidate IDs and filter disabled candidates before module import or trust prompting.
7. Trust-gate and import only remaining user candidates.
8. Resolve registration collisions among enabled extensions.

A disabled user extension must not be imported. A disabled repository extension must not trigger a
trust prompt. A statically bundled module may exist in the binary, but its factory must not run and
it must register no handlers or resources.

### Reload and lifetime invariants

Include the resolved selection snapshot in extension load compatibility. A change to effective
enablement requires registry replacement even when discovered candidates and extension config are
unchanged.

Preserve these invariants:

- delegated `hunk gh` patches live until the session owning the enabled factory shuts down;
- disabling `hunk.gh` on a later startup never runs its factory;
- disabling an active extension during config-driven reload revokes its capabilities before
  shutdown;
- staged root refinement does not execute an unchanged enabled factory twice;
- registry retirement remains idempotent.

## Implementation phases

### Phase 1: selection model and configuration

1. Add `disabled: readonly string[]` to resolved extension configuration.
2. Parse exact non-empty IDs from user and repository `[extensions]` tables.
3. Add ordered CLI override representation to command inputs.
4. Implement and unit-test the pure selection policy.
5. Document precedence, repository narrowing, and the distinction from `[extension.<id>]`.

Acceptance:

- invalid list members are rejected or normalized consistently with existing config policy;
- user and repository disables union correctly;
- CLI enable and disable operations resolve last-wins per ID;
- existing configs behave identically when `disabled` is absent.

### Phase 2: bundled definitions and `hunk.gh`

1. Give the bundled GitHub definition selection ID `hunk.gh`.
2. Keep its current registration namespace and session-owned resource lifetime.
3. Filter it before `createGitHubPrExtension` runs.
4. Retain static ownership metadata for `gh` diagnostics.
5. Add the disabled-command error and one-run recovery suggestion.

Acceptance:

- `[extensions] disabled = ["hunk.gh"]` prevents `gh` registration;
- `hunk gh ...` reports disabled, not unknown;
- `--enable-extension hunk.gh` restores it for one invocation;
- `--no-extensions` alone does not disable it;
- no GitHub temporary directory or network request is created while disabled.

### Phase 3: user extensions

1. Apply exact-ID selection after discovery identifies a candidate and before import.
2. Ensure explicit `--extension` paths obey the same policy.
3. Suppress repo trust prompts when every repo candidate is disabled.
4. Carry selection state through staged loading and registry replacement.

Acceptance:

- disabled modules cannot run top-level code;
- disabled repo extensions do not prompt for trust;
- explicit paths require `--enable-extension <id>` when persistently disabled;
- enabled candidates retain existing ordering and collision behavior.

### Phase 4: bundled UI and VCS

1. Add selection identities to the bundled VCS definitions.
2. Filter providers before catalog construction and project-root detection.
3. Add actionable diagnostics when only disabled providers match.
4. Add selection identities to independently optional bundled UI factories.
5. Keep registration IDs stable so commands, panes, and keybindings do not change.

Acceptance:

- disabling JJ or Sapling removes it from detection without affecting Git;
- explicit `--vcs <id>` reports when the corresponding extension is disabled;
- disabling search removes its commands and marks while review remains usable;
- disabling review-info or files panes does not change unrelated geometry or commands.

### Phase 5: management UX

1. Extend `extension list` with bundled and effective-state views.
2. Add safe user-config mutations for `extension enable/disable`.
3. Add explicit `--repo` mutation scope only if TOML preservation is reliable.
4. Surface stale IDs in listings without treating them as fatal configuration errors.

Acceptance:

- list output distinguishes bundled, installed, config-path, flag, and repo sources;
- mutation preserves comments and unrelated config or refuses safely;
- enabling removes the relevant disable entry rather than writing extension-owned config;
- bundled extensions cannot be removed accidentally.

## Documentation updates

Update together:

- `docs/extensions.md` for configuration, flags, management commands, and trust behavior;
- `docs/extension-architecture.md` for selection identity versus registration identity;
- generated CLI/config reference sources and website companion pages;
- `packages/hunk/skills/hunk-extensions/SKILL.md`;
- root and package READMEs if `hunk gh` examples need recovery instructions;
- a user-visible Changeset.

## Test plan

### Unit coverage

- config parsing and layer union;
- ordered CLI overrides;
- pure selection decisions and reason attribution;
- bundled catalog uniqueness and command ownership metadata;
- disabled-command diagnostics;
- load compatibility when selection changes;
- VCS detection with disabled providers;
- list projection and config mutation.

### Integration coverage

- `hunk --disable-extension hunk.gh gh --help` reports disabled;
- config-disabled `hunk.gh` plus CLI enable reaches bundled help;
- disabled explicit user extension never evaluates its module;
- disabled repo extension never prompts for trust;
- enabled `hunk gh` delegation retains and cleans its temporary patch;
- compiled headless disabled-command paths do not extract OpenTUI;
- PTY review remains usable with optional bundled UI extensions disabled.

### Verification

Run the standard relevant gates:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run deps:check
bun run test
bun run test:integration
bun run check:pack
bun run website:check
```

Run the real-TTY smoke suite when bundled UI selection changes.

## Rollout

Ship exact-ID disabling first. Do not add wildcard selectors until the stable bundled identity list
has shipped and real configuration use demonstrates a need. Preserve unknown disabled IDs so a
config can cover an extension that is temporarily absent or installed later; show them as stale in
`hunk extension list --all` rather than silently deleting user intent.
