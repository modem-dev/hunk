# Writing Hunk extensions

A Hunk extension is one TypeScript (or JavaScript) file that default-exports a
function. Hunk imports it at startup and hands it an API object. There is no
manifest and no build step.

```ts
// ~/.config/hunk/extensions/hello.ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.on("startup", (_event, ctx) => {
    ctx.notify("Hello from my extension");
  });
}
```

> Extensions are an experimental Phase 1 surface. Everything below works today;
> the API is versioned through `hunk.apiVersion` so a newer Hunk can keep
> loading extensions written against an older surface.

## Where Hunk looks for extensions

Discovery runs group by group, alphabetically by resolved path within each
group. The first occurrence of a resolved path wins, so a path you pass
explicitly keeps its origin even if the same file is also discovered somewhere
else.

| Group | Source                                               | Trust                 |
| ----- | ---------------------------------------------------- | --------------------- |
| 1     | `--extension <path>` (repeatable)                    | runs immediately      |
| 2     | `[extensions] paths` in your user config             | runs immediately      |
| 3     | `~/.config/hunk/extensions/`                         | runs immediately      |
| 4     | `.hunk/extensions/` in the repo under review         | **prompts for trust** |
| 4     | `[extensions] paths` in the repo `.hunk/config.toml` | **prompts for trust** |

The two repo-local sources share a group number because they are one group:
both are repo-controlled, so they share a trust decision and their paths are
sorted together rather than one source being loaded ahead of the other.

A directory source matches `*.ts`, `*.js`, `*.mjs` directly inside it, plus one
level of `<name>/index.{ts,js,mjs}` so a folder extension can keep helper
modules beside its entry file.

An extension's **id** is its file stem, or its folder name for
`<name>/index.ts`. The id is what `[extension.<id>]` config tables key off, so
moving a single-file extension into a folder of the same name keeps its config
working.

`--no-extensions` disables user extensions for one run — nothing on disk is
read, let alone executed. Use it when triaging a bug.

## Bundled extensions

Hunk's Jujutsu and Sapling backends are extensions. They live in
`src/extensions/bundled/`, are compiled into the binary, and register through
the same `hunk.registerVcsAdapter` this guide documents. That is deliberate:
a capability Hunk ships on keeps the published API honest, because it cannot
quietly grow past what an extension author can express.

They differ from your extensions in three ways, all of them consequences of
being Hunk's own code:

- They are **statically imported**, so they load synchronously, before config
  resolution picks the session's VCS.
- They are **implicitly trusted**: no discovery, no trust prompt, and no
  `[extension.<id>]` config table.
- They stay loaded under `--no-extensions` and `[extensions] enabled = false`.
  Those switches exist to triage extensions _you_ installed; losing jj or
  Sapling support from a debugging flag would break real work.

Failure isolation still applies to them. The ids `git`, `jj`, and `sl` are
reserved as a result — see `registerVcsAdapter` below.

## Trust

Extensions run with your user permissions, exactly like a shell dotfile. That is
fine for extensions you installed yourself, and not fine for extensions that
came with a repository you are about to review — pointing a diff tool at
unfamiliar code is a normal thing to do, and it must never execute that code.

So repo-local sources are gated. The first time Hunk finds extensions in a
repository's `.hunk/extensions` (or repo-config `paths`), it skips them and asks:

```
Run this repository's extensions?

  This repository contains extensions in .hunk/extensions.
  Extensions run with your user permissions.

  enter/t trust · esc not now · n never
```

- **Trust** records the decision and reloads the session so the repo's
  extensions take effect immediately.
- **Not now** (also `Esc`) dismisses without recording anything; you will be
  asked again next time.
- **Never** records a denial so Hunk stops offering.

Decisions are stored per repository root in `~/.config/hunk/state.json`. The
prompt is a normal dialog over the review stream, not a gate in front of it:
you can dismiss it and keep reviewing.

Trust is keyed by the repo root's **path**, not by the repository's identity —
the same model VS Code workspace trust uses. If you delete a trusted checkout
and a different repository later occupies that path, it inherits the decision.
Clear the entry from `state.json` if that matters for a path you reuse.

## Failure isolation

A broken extension never breaks review. An extension that fails to import, has
no default export, or throws from its factory is skipped, its partial
registrations are rolled back, and it becomes a startup notice in the footer.
A handler or transform that throws later is reported as a warning naming the
extension, and everything else keeps running.

## The API

The factory receives one object. Registration calls are only valid while the
factory is running; Hunk seals the object afterwards so a deferred callback
cannot mutate the registry mid-session.

### `hunk.apiVersion`

The API generation this Hunk speaks (currently `1`). Branch on it if you want
one file to support several Hunk versions.

### `hunk.registerTheme(theme)`

Contribute one selectable theme. The object is the same shape as a
`[themes.<id>]` config table:

```ts
hunk.registerTheme({
  id: "midnight-review",
  label: "Midnight Review",
  base: "catppuccin-mocha",
  accent: "#7fd1ff",
  syntax_scopes: { "keyword.operator": "#7fd1ff" },
});
```

Theme ids must be lowercase words separated by `-` or `_` and cannot reuse a
built-in id. Config-defined themes always win over extension themes for the same
id; the loser is reported as a startup notice. Extension themes appear in the
selector after config themes, in load order.

### `hunk.registerFileLanguage(extension, language)`

Map a file extension to a syntax-highlighting language. The extension may be
written with or without a leading dot and is lowercased.

```ts
hunk.registerFileLanguage(".zig", "zig");
hunk.registerFileLanguage("bzl", "python");
```

Later registrations win over earlier ones. Hunk's own `.mts` and `.cts`
mappings cannot be overridden; attempts are skipped with a notice.

### `hunk.registerVcsAdapter(adapter)`

Contribute an additional VCS backend. This is the same call Hunk's own bundled
Jujutsu and Sapling backends make.

```ts
hunk.registerVcsAdapter({
  id: "hg",
  name: "Mercurial",
  detect: (cwd) => (existsSync(join(cwd, ".hg")) ? { id: "hg", repoRoot: cwd } : null),
  operations: {
    "working-tree-diff": {
      async load(input, ctx) {
        return {
          repoRoot: ctx.cwd,
          sourceLabel: ctx.cwd,
          title: "Mercurial working copy",
          patchText: await runHgDiff(ctx.cwd),
          untrackedPaths: await listHgUnknownFiles(ctx.cwd),
        };
      },
    },
  },
});
```

The ids Hunk ships with — `git`, `jj`, and `sl` — are reserved. An adapter that
reuses one is skipped with a notice.

`operations` is optional and may implement any of `working-tree-diff`,
`revision-show`, and `stash-show`; an operation you leave out — or leaving the
map off entirely — produces a clear "not supported" error for that command
instead of a crash.

A `load` result is patch text plus how to label it. `untrackedPaths` is
optional: list the repo-root-relative paths your VCS reports as unknown and Hunk
synthesizes the added-file diffs for you, skipping binaries and files too large
to render. Honor `input.options.excludeUntracked` when you do, so
`--exclude-untracked` still means what it says.

#### Detection order

Detection prefers the **nearest** checkout: a Git repository nested inside a jj
workspace is reviewed as Git, whatever the priorities say. `detectionPriority`
only decides which backend wins when several recognize the _same_ directory —
the colocated case, where one working copy carries two sets of markers.

| Adapter                  | Priority                                     |
| ------------------------ | -------------------------------------------- |
| bundled `jj`             | 200                                          |
| bundled `sl`             | 100                                          |
| core `git`               | 0 (`HUNK_CORE_VCS_DETECTION_PRIORITY`)       |
| your adapter, by default | -100 (`HUNK_DEFAULT_VCS_DETECTION_PRIORITY`) |

Higher is consulted first; equal priorities fall back to registration order.
jj and Sapling sit above Git because a colocated jj repository — or a Sapling
repository created with `sl init --git` — also carries Git metadata, and the
Git view is the wrong one.

The default puts your adapter below Git, so installing an extension never
silently changes how an existing repository is reviewed. Set
`detectionPriority` explicitly to outrank a shipped backend; it is your machine.

```ts
import { HUNK_CORE_VCS_DETECTION_PRIORITY } from "hunkdiff/extension";

hunk.registerVcsAdapter({
  id: "hg",
  name: "Mercurial",
  detectionPriority: HUNK_CORE_VCS_DETECTION_PRIORITY + 10,
  detect,
});
```

One more rule applies only to extensions you install: config resolves the
session's VCS before your extension has been imported, so a user adapter may
claim a directory nothing shipped recognized, but never overrides one that was
recognized. Bundled adapters have no such restriction — they load with core
adapter resolution and take part in detection from the start.

#### Watch support

`--watch` works through extension adapters. Each operation may add:

- `watchSignature(input, ctx)` — a cheap fingerprint of the reviewed state.
  Hunk polls it and reloads when it changes.
- `watchPlan(input, ctx)` — the filesystem targets that cover that state, so
  Hunk reacts to events instead of polling on a timer.

```ts
watchPlan: (input, ctx) => ({
  coverage: "hybrid",
  targets: [
    {
      kind: "directory-tree",
      directory: ctx.cwd,
      ignoredRoots: [join(ctx.cwd, ".hg")],
      sources: ["worktree"],
    },
  ],
}),
```

`coverage: "hybrid"` promises the targets cover the reviewed state. Leaving
`watchPlan` out is equivalent to `poll-only` and still works — it just costs a
subprocess per tick.

#### What core Git can do that an adapter cannot

Two capabilities are deliberately not on the contract, because both reach into
Hunk's diff engine rather than describing a VCS:

- **Exact source fetchers.** Git tells Hunk how to read each file's full old and
  new content (`git show <ref>:<path>`, the index, the worktree), which sharpens
  syntax highlighting and word diffing beyond what the patch alone carries.
  Expressing that means publishing the diff engine's per-file model. Adapters
  fall back to patch-derived content, which is what jj and Sapling do today.
- **Pre-built diff files.** Git synthesizes placeholder entries for files too
  large to render, using parsed diff metadata. `untrackedPaths` covers the
  common case an adapter actually needs; the general form does not have a
  publishable shape yet.

Neither gap affects correctness — a review through an extension adapter renders
the same patch, in the same stream, with the same navigation.

### `hunk.transformChangeset(fn)`

Rewrite the loaded changeset before it reaches the review UI. Transforms run in
registration order, each seeing the previous one's output, on first load and on
every reload.

```ts
hunk.transformChangeset((changeset) => ({
  ...changeset,
  files: changeset.files.filter((file) => !file.path.endsWith(".lock")),
}));
```

The function may be async. Filtering and reordering `files` is fully supported —
the sidebar and the review stream both follow whatever you return.

Each file carries an opaque `metadata` field: it is the parsed diff the renderer
draws from, so pass it through untouched (spreading a file preserves it). What
you return is validated before it is reviewed. A transform that throws, or
returns something the review UI could not draw — not a changeset with a `files`
array, a file missing `metadata.hunks` or `stats`, two files sharing an `id` —
is skipped: the previous changeset carries forward and you get a warning naming
your extension and the problem.

### `hunk.on(event, handler)`

Subscribe to a lifecycle event. Handlers may be async; Hunk never blocks the UI
waiting for one.

| Event               | Payload                 | When                                                 |
| ------------------- | ----------------------- | ---------------------------------------------------- |
| `startup`           | `{ cwd }`               | once, after the app mounts with its first changeset  |
| `changeset_loaded`  | `{ changeset }`         | first load and every reload                          |
| `selection_changed` | `{ fileId, hunkIndex }` | when the review selection settles (debounced ~150ms) |
| `session_reload`    | `{ changeset, reason }` | on every session reload                              |
| `shutdown`          | `{}`                    | on exit, best-effort within a short timeout          |

`selection_changed` is trailing-debounced on purpose: holding `[`/`]` retargets
the selection many times a second, and handlers only care where the user landed.
`fileId` and `hunkIndex` are `null` when nothing is selected.

`session_reload`'s `reason` is `"watch"` (the watcher saw the source change),
`"daemon"` (an agent command through the session broker), or `"manual"` (the
refresh key, or the reload after granting extension trust).

`shutdown` handlers get a short window (250ms) to finish before Hunk exits
anyway, so treat it as best-effort flushing rather than guaranteed cleanup.

### `hunk.config`

Your extension's own `[extension.<id>]` config table, as a plain object. Hunk
does not interpret the keys — unknown keys pass straight through — and repo
config overrides user config key by key.

> **Treat these values as untrusted.** Tables merge by extension id with no
> notion of where the extension was installed from, so a repository under review
> can set or override configuration for an extension you installed globally.
> That is deliberate — repo-level tuning of a shared extension is a normal team
> workflow, and Hunk shows a startup notice listing the extension ids a repo
> configures — but it means `hunk.config` must never be trusted for
> exec-adjacent decisions such as binary paths, shell commands, or module
> loading. Validate those against something the user controls.

```toml
# ~/.config/hunk/config.toml
[extension.collapse-generated]
patterns = ["*.lock", "dist/**"]
```

```ts
const patterns = (hunk.config.patterns as string[] | undefined) ?? ["*.lock"];
```

### `ctx.notify(message, type?)`

Every handler and transform receives a context object with `cwd` and `notify`.
`notify` shows a single unobtrusive line at the bottom of the app that clears
itself after a few seconds; queued messages appear in turn. `type` is `"info"`
(default), `"warning"`, or `"error"`, which selects the color. Notifications
raised before the UI has mounted are buffered and flushed once it does, so a
`startup` handler can notify safely.

### `hunk.log(message)`

Record a diagnostic line. Logs are collected per extension rather than written
to the terminal, because the TUI owns the screen.

## A complete example

Collapse lockfiles and generated output out of every review, and say how many
files were hidden.

```ts
// ~/.config/hunk/extensions/collapse-generated.ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

/** Match one path against a `*`-only glob, anchored at both ends. */
function matchesPattern(path: string, pattern: string) {
  const source = pattern
    .split("*")
    .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
}

export default function (hunk: HunkExtensionAPI) {
  const patterns = (hunk.config.patterns as string[] | undefined) ?? [
    "*.lock",
    "*-lock.json",
    "dist/*",
  ];

  hunk.transformChangeset((changeset, ctx) => {
    const kept = changeset.files.filter(
      (file) => !patterns.some((pattern) => matchesPattern(file.path, pattern)),
    );

    const hidden = changeset.files.length - kept.length;
    if (hidden > 0) {
      ctx.notify(`Collapsed ${hidden} generated ${hidden === 1 ? "file" : "files"}`);
    }

    return { ...changeset, files: kept };
  });
}
```

Configure it without touching the code:

```toml
# .hunk/config.toml
[extension.collapse-generated]
patterns = ["*.lock", "bun.lockb", "generated/*"]
```

Try it against the working tree without installing it:

```bash
hunk diff --extension ./collapse-generated.ts
```

## CLI flags and config reference

```bash
hunk diff --extension ./path/to/entry.ts   # load one entry file or directory (repeatable)
hunk diff --no-extensions                  # disable user extensions for this run
```

```toml
# ~/.config/hunk/config.toml or .hunk/config.toml
[extensions]
enabled = true                      # false disables loading for this layer
paths = ["~/dev/hunk-ext/index.ts"] # extra entry files or directories

[extension.my-extension]            # opaque payload handed to that extension
some_key = "some value"
```

`[extensions] enabled` layers like every other option: a repo `.hunk/config.toml`
overrides your user config. `--no-extensions` is a hard off switch that no config
layer can re-enable. Both govern **user** extensions only — Hunk's bundled
Jujutsu and Sapling backends load either way. `[extensions] paths` from a repo
config is trust-gated the same way `.hunk/extensions` is, because it is
repo-controlled either way.

## Not in Phase 1

Actions, keybindings, menu entries, custom note renderers, session commands, and
CLI subcommands are not contributable yet. They depend on a named-action registry
in Hunk core; see
[docs/extension-system-exploration.md](extension-system-exploration.md) for the
design and phasing.
