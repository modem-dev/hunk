---
title: Extensions
description: Load plain TypeScript extensions, understand discovery and trust, and configure them.
---

A Hunk extension is one TypeScript (or JavaScript) file that default-exports a function. Hunk imports it at startup and hands it an API object. No build step is required.

```ts
// ~/.config/hunk/extensions/hello.ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.on("startup", (_event, ctx) => {
    ctx.notify("Hello from my extension");
  });
}
```

**The API is experimental**: `hunkdiff/extension` may change in breaking ways between minor releases while it stabilizes. Breaking changes are called out in release notes, and `hunk.apiVersion` identifies the surface an extension was written against.

What an extension can register is covered by the companion pages: the [extension API](/docs/extend/extension-api/), [file previews](/docs/extend/file-previews/), [VCS adapters](/docs/extend/vcs-adapters/), and [custom panes](/docs/extend/custom-sidebars/).

Writing one with a coding agent? `hunk skill path hunk-extensions` prints a bundled skill that maps these touchpoints for agents, the way `hunk skill path` does for reviewing.

## Where Hunk looks

| Group | Source                                               | Runs                  |
| ----- | ---------------------------------------------------- | --------------------- |
| 1     | `--extension <path>` (repeatable)                    | immediately           |
| 2     | `[extensions] paths` in your user config             | immediately           |
| 3     | `~/.config/hunk/extensions/`                         | immediately           |
| 4     | `.hunk/extensions/` in the repo under review         | after [trust](#trust) |
| 4     | `[extensions] paths` in the repo `.hunk/config.toml` | after [trust](#trust) |

- Groups load in order; within a group, entries sort alphabetically by resolved path. The first occurrence of a path wins.
- The two repo-local sources are one group: one trust decision, one sort order.
- A directory source matches `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.mjs` directly inside it, plus one level of folder extensions.
- `--no-extensions` disables user extensions for one run; nothing on disk is read.
- `--extension` is explicit intent: it loads immediately, without a trust prompt, even from inside the reviewed repo — so never pass a path you have not read.

### Folder extensions

A folder is an extension if its `package.json` declares entries under the `hunk` field, or failing that if it has an `index.{ts,tsx,js,jsx,mjs}` (in that preference order):

```text
~/.config/hunk/extensions/my-ext/
  package.json          # {"hunk": {"extensions": ["./src/index.ts"]}}
  node_modules/         # bun install / npm install, right here
  src/
    index.ts            # the declared entry
    helper.ts
```

- Manifest paths resolve against the folder and may list several entries; each loads as its own extension, in manifest order.
- The manifest is a real `package.json`, so a folder extension can depend on npm packages installed into its own `node_modules`.
- Pointing `--extension` or `[extensions] paths` at a directory works either way: a folder extension loads as one extension; any other directory is scanned as a directory _of_ extensions.

### Extension ids

The **id** is the file stem, or the folder name for `<name>/index.ts` and single-entry manifests. It is the key for everything the extension owns:

- config: `[extension.<id>]`
- commands: `<id>.<commandId>`
- panes: `<id>:<paneId>`
- file previews: `<id>:<viewId>`

Ids start with a letter or digit, then letters, digits, `-`, or `_`. `hunk`, `git`, `jj`, and `sl` are reserved. An invalid id — or a second source offering an already-loaded id — is skipped with a startup notice.

## Installing shared extensions

Extensions are shared as plain git repositories. `hunk extension install` clones one into a managed directory under `~/.config/hunk/extensions/installed/`, verifies it contains an extension, installs its npm dependencies when it declares any, and records the source and commit:

```bash
hunk extension install acme/hunk-word-diff          # GitHub shorthand
hunk extension install acme/hunk-word-diff@v1.2.0   # pin a tag, branch, or commit
hunk extension install git:codeberg.org/acme/ext    # any host; https:// is assumed
hunk extension install ~/dev/hunk-word-diff         # a local checkout, for testing
```

- `hunk extension list` shows every managed install with its version, commit, and source.
- `hunk extension update [name]` re-clones one install (or all of them) from its recorded source; an `@ref` pin stays put until you re-install with a different one.
- `hunk extension remove <name>` deletes the install and its record. Hand-copied extensions in `~/.config/hunk/extensions/` are never touched.

Installing is the consent step: extensions run with your full user permissions, so a fresh install asks for confirmation (or takes `--yes`) after naming the repository. Only install repositories you trust. Managed installs then load through the global group above — same precedence, no further prompts.

Community extensions are listed at [hunk.dev/extensions](/extensions/), and the full tail is the [`hunk-extension` topic on GitHub](https://github.com/topics/hunk-extension).

## Publishing an extension

A publishable extension repository is the folder-extension layout at the repository root — `package.json` with a `hunk` field (or an `index.*` entry), code, README. To share one:

1. Fill in `package.json`'s `name`, `version`, and `description`, and declare `"hunk": {"apiVersion": N}` if you rely on recent API surface — an older Hunk then refuses the install cleanly instead of failing mid-load.
2. Keep `dependencies` real: they are installed into the extension's own `node_modules` at install time. `react`, `@opentui/*`, and `hunkdiff/extension` come from the host at runtime and belong in `devDependencies`.
3. Tag releases so users can pin with `@v1.2.0`.
4. Push to any git host and add the **`hunk-extension`** GitHub topic, then open a pull request to list it on [hunk.dev/extensions](/extensions/).

Test the exact layout users will get with `hunk extension install /path/to/checkout`, or load it for one run with `hunk diff --extension /path/to/checkout`.

## Bundled extensions

Hunk's Git, Jujutsu, Sapling, and file-navigation pane use the same public extension API. Bundled extensions differ from yours in three ways:

- statically imported, so they load before config resolution picks the session's VCS
- implicitly trusted, with no `[extension.<id>]` config table
- still loaded under `--no-extensions` and `[extensions] enabled = false` — those switches triage extensions _you_ installed

## Trust

Extensions run with your full user permissions, and reviewing a repository must never execute code that came with it. So the repo-local sources stay inert until you approve them, once per repository:

```text
Run this repository's extensions?

  This repository contains extensions in .hunk/extensions.
  Extensions run with your user permissions.

  enter/t trust · esc not now · n never
```

**Trust** records the decision and reloads the session; **not now** asks again next time; **never** stops the offers. The prompt is a dialog over the review stream, not a gate in front of it — dismiss it and keep reviewing.

Decisions are stored per repository root in `~/.config/hunk/state.json`, keyed by path (the VS Code workspace-trust model). A different repository later occupying a trusted path inherits the decision; clear the entry if that matters for a path you reuse.

## Failure isolation

A broken extension is contained, not fatal: a failed import, missing default export, or throwing factory is skipped and rolled back with a startup notice; a handler or transform that throws later becomes a warning naming the extension. Event handlers receive frozen changeset copies, so accidental mutation throws instead of corrupting the review.

Extensions run with your shell permissions. For reviewed files, prefer [`ctx.workspace`](/docs/extend/extension-api/#workspace-documents); writes require consent and identify the extension and file.

## CLI flags and config

```bash
hunk diff --extension ./path/to/entry.ts   # load one entry file (repeatable)
hunk diff --extension ./my-ext             # a folder extension: loads ./my-ext/index.ts
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

`[extensions] enabled` layers like every other option (repo config overrides user config); `--no-extensions` is a hard off switch no config layer can re-enable. `[extension.<id>]` tables pass through to the extension uninterpreted — see [`hunk.config`](/docs/extend/extension-api/#hunkconfig) for the merge rules and their caveats.

## A complete example

Collapse lockfiles and generated output out of every review, and say how many files were hidden.

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

Continue with the [extension API](/docs/extend/extension-api/) for everything the API object offers.
