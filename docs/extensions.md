# Writing Hunk extensions

A Hunk extension entry is one TypeScript (or JavaScript) file that
default-exports a function. Hunk imports it at startup and hands it an API
object. An entry may stand alone or be declared by a folder's optional
`package.json` manifest; no build step is required.

```ts
// ~/.config/hunk/extensions/hello.ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.on("startup", (_event, ctx) => {
    ctx.notify("Hello from my extension");
  });
}
```

> **The extension API is experimental.** Everything below works today, but the
> `hunkdiff/extension` surface may change in breaking ways between minor
> releases while it stabilizes against real third-party extensions. Breaking
> changes will be called out in release notes, and `hunk.apiVersion` identifies
> the surface an extension was written against.

Writing one with a coding agent? `hunk skill path hunk-extensions` prints a
bundled skill that maps the touchpoints below for agents, the way
`hunk skill path` does for reviewing.

## Where Hunk looks for extensions

Discovery runs group by group, alphabetically by resolved path within each
group — a folder extension's entries sort together, at the folder's own path.
The first occurrence of a resolved path wins, so a path you pass explicitly
keeps its origin even if the same file is also discovered somewhere else.

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

A directory source matches `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.mjs` directly
inside it, plus one level of folder extensions, so a folder extension can keep
helper modules beside its entry file.

A folder is an extension if it declares its entry files in a `package.json`, or
failing that if it has an `index.{ts,tsx,js,jsx,mjs}` (in that preference
order, so a folder shipping both a source and a built entry resolves the same
everywhere). The manifest field is `hunk`:

```text
~/.config/hunk/extensions/my-ext/
  package.json          # {"hunk": {"extensions": ["./src/index.ts"]}}
  node_modules/         # bun install / npm install, right here
  src/
    index.ts            # the declared entry
    helper.ts
```

The manifest wins over the `index.*` fallback, and its paths resolve against the
folder. It may list more than one entry, in which case each entry loads as its
own extension in the order the manifest gives. Each one is identified by its
file stem; when stems collide, later entries receive a numeric suffix while
avoiding ids already claimed by other entries in the manifest.

Because the manifest is a real `package.json`, a folder extension may depend on
npm packages: declare them, install them into the folder's own `node_modules`,
and imports resolve from the entry file the way they do in any other package.

The `hunk` field may also state the minimum extension API version the folder
needs:

```json
{
  "name": "my-ext",
  "version": "1.0.0",
  "description": "What the extension does",
  "hunk": { "extensions": ["./src/index.ts"], "apiVersion": 3 }
}
```

A Hunk whose extension API is older than `apiVersion` refuses the folder with a
startup notice naming the version it would need, instead of failing somewhere
inside the factory with whatever error the missing surface happens to produce.
Omit it while you only use surface that has been around a while; declare it when
you depend on something recent (the current version is exported as
`HUNK_EXTENSION_API_VERSION` from `hunkdiff/extension` and handed to factories
as `hunk.apiVersion`). The standard `name`, `version`, and `description` fields
are how tooling and humans identify a shared extension, so fill them in on
anything you publish.

Pointing `--extension` or `[extensions] paths` straight at a directory works
either way: a directory that is itself a folder extension loads as that one
extension, so its helper modules stay helpers. A directory that is not is
treated as a directory _of_ extensions and scanned with the patterns above.

An extension's **id** is its file stem, or its folder name for
`<name>/index.ts`. A manifest that declares a single entry also keeps the
folder's name, whatever the entry file is called. The id is what
`[extension.<id>]` config tables key off, so moving a single-file extension into
a folder of the same name — or later giving that folder a manifest — keeps its
config working.

The id is also the namespace your extension owns: its commands are
`<id>.<commandId>` and its panes `<id>:<viewId>`. So the id has to be
spelled like a name — starting with a letter or digit, then letters, digits,
`-`, or `_`. A dot or a colon would make those composed ids ambiguous, and
`hunk`, `git`, `jj`, and `sl` are reserved for what Hunk ships. An extension
whose id breaks a rule is skipped with a startup notice naming the file; rename
it and it loads. If two discovery sources offer the same id, the first in
[source order](#where-hunk-looks-for-extensions) loads and the other is skipped the
same way, since one id cannot own two config tables.

`--no-extensions` disables user extensions for one run — nothing on disk is
read, let alone executed. Use it when triaging a bug.

`--extension` is explicit user intent: the file loads immediately, with no
trust prompt, even when the path points inside the repository under review.
Never pass a path you have not read — including one copy-pasted from a
repository's own README.

## Sharing and installing extensions

Extensions are shared as plain git repositories — there is no registry to
publish to. `hunk extension install` clones one into a managed directory
(`~/.config/hunk/extensions/installed/<repo-name>/`), verifies it actually
contains an extension, installs its npm dependencies when it declares any, and
records the source and resolved commit:

```bash
hunk extension install acme/hunk-word-diff          # GitHub shorthand
hunk extension install acme/hunk-word-diff@v1.2.0   # pin a tag, branch, or commit
hunk extension install git:codeberg.org/acme/ext    # any host; https:// is assumed
hunk extension install https://github.com/acme/hunk-word-diff.git
hunk extension install ~/dev/hunk-word-diff         # a local checkout, for testing
```

Managed installs load through the global source group — same origin, same
precedence, no trust prompt — because installing one is the explicit consent:
the install asks for confirmation (or `--yes`) after stating that extensions
run with your full user permissions. Only install repositories you trust.

`hunk extension list` shows every managed install with its version, commit, and
source. `hunk extension update [name]` re-clones one install (or all of them)
from its recorded source — an install pinned with `@ref` stays at that ref
until you re-install with a different one. `hunk extension remove <name>`
deletes the install and its record. Managed installs never collide with
extensions you copied into `~/.config/hunk/extensions/` by hand, and the
installer refuses to overwrite an unmanaged directory of the same name.

### Publishing an extension

A publishable extension repository is just the folder-extension layout at the
repository root:

```text
hunk-word-diff/
  package.json          # name, version, description, hunk field
  index.ts              # or entries declared in "hunk": {"extensions": [...]}
  README.md
```

To publish one:

1. Give `package.json` a real `name`, `version`, and `description`, declare
   entries under the `hunk` field, and state `"hunk": {"apiVersion": N}` if you
   rely on recent API surface (see [the manifest](#where-hunk-looks-for-extensions)).
2. Keep it dependency-light. Declared `dependencies` are installed with
   `bun install` at install time when the user has `bun` on PATH; without it
   they get a warning and instructions. `react`, `@opentui/*`, and
   `hunkdiff/extension` come from the host at runtime and belong in
   `devDependencies` (types only), never `dependencies`.
3. Tag releases (`v1.2.0`) so users can pin with `@v1.2.0` instead of tracking
   your default branch.
4. Push the repository to any git host and add the **`hunk-extension`** GitHub
   topic so people can find it: every public repository with that topic shows
   up at <https://github.com/topics/hunk-extension>. Opening a pull request
   against `website/src/data/extensions.ts` also lists it on
   <https://hunk.dev/extensions>.

Before publishing, exercise the exact layout users will install:
`hunk extension install /path/to/your/checkout` installs from a local
repository, and `hunk diff --extension /path/to/your/checkout` loads it for one
run without installing anything.

## Bundled extensions

Every VCS backend Hunk ships — **Git, Jujutsu, and Sapling** — is an extension,
and so is the **built-in file-navigation pane**. They live in
`src/extensions/default/`, are compiled into the binary, and register through
the same `hunk.registerVcsAdapter` and `hunk.registerPane` this guide
documents. There is no private registration path.

Git in particular is the reason: it is the backend that exercises every
integration point there is — exact file sources, skipped-too-large placeholders,
untracked files, watch plans, rich failures — so running it through the
published API is what keeps that API honest. Anything Git can do, your adapter
can do, because Git does it the same way you would.

Bundled extensions differ from yours in three ways, all of them consequences of
being Hunk's own code:

- They are **statically imported**, so they load synchronously, before config
  resolution picks the session's VCS.
- They are **implicitly trusted**: no discovery, no trust prompt, and no
  `[extension.<id>]` config table.
- They stay loaded under `--no-extensions` and `[extensions] enabled = false`.
  Those switches exist to triage extensions _you_ installed; losing VCS support
  from a debugging flag would break every workflow there is.

Failure isolation still applies to them. The ids `git`, `jj`, and `sl` are
reserved as a result — see `registerVcsAdapter` below — and so is `hunk`, the
id the bundled files pane and every built-in command are named under.

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

A broken extension should not break review. An extension that fails to import,
has no default export, or throws from its factory is skipped, its partial
registrations are rolled back, and it becomes a startup notice in the footer.
A handler or transform that throws later is reported as a warning naming the
extension, and everything else keeps running. Event handlers receive frozen
copies of the changeset, so accidental mutation throws inside the handler
instead of corrupting the review.

This is crash containment, not a sandbox. Per-file `metadata` inside event
payloads is shared with the renderer for performance and is not frozen, and an
extension runs with your full user permissions — it can do anything your shell
can. The containment protects you from bugs, not from code you should not have
loaded in the first place. For reviewed files, prefer [`ctx.workspace`](#workspace-documents). It attributes
writes to the extension and asks for consent.

## The API

The factory receives one object. Registration calls are only valid while the
factory is running; Hunk seals the object afterwards so a deferred callback
cannot mutate the registry mid-session. Keep the factory registration-only:
start watchers, processes, connections, and other long-lived resources from
`startup`, and release them from `shutdown`. Extension-registry reloads create
new instances and run that shutdown/startup pair around the replacement.

An interactive history workspace owns one extension instance for its complete
lifetime. Opening a commit review inside that workspace borrows the same
instance: the factory and `startup` do not run again, and returning to history
does not send `shutdown`. Review-specific `changeset_loaded` events still run
for each opened commit. The owning history workspace sends the one eventual
`shutdown` when it exits. This makes module-local clients and stores safe to
share deliberately between retained history and its commit reviews without a
review closing resources that history still uses.

Keep mutable review-generation data keyed by the identities in event payloads
or replace it on `changeset_loaded`; module scope is workspace state, not a
fresh namespace per opened commit. An embedded review cannot replace its
borrowed registry; extension replacement remains an operation of the owning
workspace. A true owner-driven extension-registry reload creates a new instance
and retires the replaced instance at that explicit ownership boundary.

### `hunk.apiVersion`

The API generation this Hunk speaks (currently `19`). Branch on it if you want
one file to support several Hunk versions. Version 19 adds provider-owned history
enumeration and review planning; version 18 lets lifecycle and custom-event handlers request
a host-owned review reload; version 17 adds structured review metadata to delegated patch
commands and projects it into pane availability and component props; version 16 adds pane-wide
`onActivate`; version 15 added `{ side, line }` to opted-in pane `currentLine`
paint; version 14 added structured `rangeEndpoints`
to two-revision VCS diff requests; version 13 added saved-note parent identities and
committed note-edit events; version 12 adds responsive fractional pane sizing; version 11 added
the `"dim"` line-highlight tone; version 10 added generic top-level CLI commands; version 9
added exact-filename and glob selectors to `registerFileLanguage`; version 8
added authoritative review snapshots to command handlers; version 7 added the
current source line to command selection snapshots. Version 6 added session behavior,
terminal-command observation, and live navigation/dialogs in event handlers;
version 5 added line highlighters and line-granular navigation (`revealLine`);
version 4 added keyboard modes and docked panes, with API-v3 sidebar names
remaining as deprecated aliases.

### `hunk.registerCliCommand(command, handler)`

Register a generic top-level command tree. The name must use lowercase kebab
case, cannot replace a built-in command or alias, and is global across loaded
extensions. Discovery order decides collisions: explicit flag, user-config path,
global/managed, then trusted repo extensions; the first claim wins.

```ts
hunk.registerCliCommand(
  { name: "greptile", summary: "Work with Greptile", usage: "<sync|review>" },
  async (args, ctx) => {
    if (args[0] === "sync") {
      await ctx.stdout.write("Synced.\n");
      return { kind: "exit", code: 0 };
    }

    await ctx.stderr.write("Preparing review…\n");
    return {
      kind: "delegate",
      argv: ["patch", "review.diff"],
      review: {
        kind: "change-request",
        provider: "GitHub",
        title: "Add structured review metadata",
        url: "https://github.com/acme/project/pull/123",
        id: "#123",
        repository: "acme/project",
        author: "octocat",
        base: "main",
        head: "review-metadata",
        state: "open",
        draft: false,
      },
    };
  },
);
```

The handler receives the frozen raw tokens below its top-level name plus
`ctx.cwd`, cooperative `ctx.signal`, byte-streaming `ctx.stdin`, and leased,
backpressure-aware `ctx.stdout`/`ctx.stderr`. It may use ordinary JavaScript APIs
to access networks, processes, services, and files. Return `{ kind: "exit",
code? }` with a status from 0 through 255, or delegate exactly once to a
built-in Hunk command.

A delegated built-in `patch` command may include a provider-neutral `review` descriptor. Its
`kind` is `change-request`, `commit`, or `comparison`; each exact shape combines bounded display
strings with an optional credential-free HTTPS URL. Hunk rejects unknown fields, control
characters, invalid types, unsafe URLs, fields over their byte limits, and descriptors over 4 KiB,
then copies and freezes the accepted value. `provider` and change-request `id` allow 256 bytes;
`repository`, `author`, `base`, `head`, and `revision` allow 512; `title` and `url` allow 2 KiB.
Change requests may also carry `state` (`open`, `closed`, or `merged`) and boolean `draft`. Exit results and delegation to any built-in other than
`patch` cannot carry review metadata. An ordinary `hunk patch` has no descriptor.

The descriptor describes the review source rather than its diff contents: it stays on the app
bootstrap and does not enter changeset transforms or `ReviewDocumentV1`. Refreshing the same
file-backed patch preserves it, including watch and manual refresh; an explicit reload to a
different patch path or input kind clears it. Live-session list, context, and review JSON snapshots
project the same optional descriptor from registration metadata; it remains outside the semantic
review document and grants no remote reload or provider capability.

Delegation cannot target another extension command or change extension bootstrap
flags. Do not write stdout or read stdin before delegating; use stderr for
progress. Reading stdin is an exit-only workflow because even a pending read can
steal terminal input from the delegated command. Writers and stdin iterators
reject after the handler settles. SIGINT and SIGTERM abort
`ctx.signal`; handlers should stop promptly. Extensions are not sandboxed, so
direct process stream access cannot be enforced by these capabilities and must
be avoided.

Bare `hunk --help` remains static and does not load extensions. The extension
owns `hunk <name> --help` and receives `--help` unchanged.

`summary` and `usage` are what Hunk shows when a top-level token reaches
extension discovery but no extension claims it. That failure has already paid
for the registry, so it lists every loaded command rather than only naming the
token that was wrong:

```text
hunk: Unknown command: nosuchthing

Extension commands available here:
hunk cli-tools <status|review> [args...] — Demonstrate extension-provided CLI workflows
hunk gh <number|owner/repo#number|pull-request-url> [--repo <owner/repo>] — Review a GitHub pull request
```

Both fields are collapsed to one sanitized line, so an extension cannot forge
host output with newlines or escape sequences.

The dependency-free [`github-pr` example](../examples/extensions/github-pr/)
is a complete network workflow built on this contract. It fetches bounded GitHub PR metadata and
the diff without the `gh` CLI, attaches a `change-request` descriptor so the bundled review-info
pane shows the provider facts above the diff, writes a temporary patch with restrictive POSIX modes
(and inherited temporary-directory ACLs on Windows), delegates to the built-in `patch` command, and
removes the patch on extension shutdown. Run it
from this checkout with:

```bash
bun run src/main.tsx --extension ./examples/extensions/github-pr gh 123
```

### `hunk.configureSession(options)`

Request host-level behavior for the review session loading the extension. Use
`{ viewPreferences: "transient" }` for training, demos, and presentations that
deliberately exercise view controls but must never offer to save their final
practice state into the user's config. If any loaded extension requests it, the
shared session skips the save-view-preferences prompt on quit.

```ts
hunk.configureSession({ viewPreferences: "transient" });
```

The default is `{ viewPreferences: "default" }`. Like every registration-time
call, this must run synchronously while the factory is loading.

### `hunk.registerTheme(theme)`

Contribute one selectable theme. The object is the same shape as a
`[themes.<id>]` config table:

```ts
hunk.registerTheme({
  id: "midnight-review",
  label: "Midnight Review",
  base: "catppuccin-mocha",
  accent: "#7fd1ff",
  syntaxScopes: { "keyword.operator": "#7fd1ff" },
});
```

Theme ids must be lowercase words separated by `-` or `_` and cannot reuse a
built-in id. Config-defined themes always win over extension themes for the same
id; the loser is reported as a startup notice. Extension themes appear in the
selector after config themes, in load order.

### `hunk.registerFileLanguage(matcher, language)`

Map file extensions, exact filenames, or globs to an existing syntax-highlighting language. The
string shorthand registers a case-insensitive extension with or without its leading dot. Explicit
extension matchers use the same trimming, leading-dot removal, and lowercasing:

```ts
hunk.registerFileLanguage(".zig", "zig");
hunk.registerFileLanguage({ kind: "extension", value: "bzl" }, "python");
hunk.registerFileLanguage({ kind: "filename", value: "BUILD" }, "python");
hunk.registerFileLanguage(
  { kind: "glob", value: "generated/**/*.proto", target: "path" },
  "protobuf",
);
hunk.registerFileLanguage({ kind: "glob", value: "*.component", target: "basename" }, "typescript");
```

Filename and glob matching is case-sensitive on every platform. Exact filenames match a basename
at any directory depth. Globs use Bun's shell-style glob syntax and must explicitly target either
the basename or the review path exactly as Hunk decoded it. `/` is the review-path separator;
backslashes remain literal filename characters. Exact filename and glob values preserve leading and
trailing whitespace. Globs reject NUL and do not run against NUL-bearing decoded patch paths; exact
filename selectors can still address those paths. VCS review paths are normally repo-relative,
while generic patch input may carry an absolute path.

Hunk's reserved `.mts` and `.cts` mappings run first and cannot be overridden. Otherwise, exact
filenames take precedence over globs, which take precedence over extensions. The longest matching
extension wins, and later registrations win ties within each category. Direct attempts to register
those two reserved extensions are skipped with a notice.

This API selects a language already available to Pierre/Shiki. It does not load a new syntax
grammar; an unknown language remains plain text.

### `hunk.registerVcsAdapter(adapter)`

Contribute an additional VCS backend. This is the same call Hunk's own bundled
Git, Jujutsu, and Sapling backends make.

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

API version 17 adds the optional, read-only `history` capability used by the built-in `hunk log` surface:

```ts
hunk.registerVcsAdapter({
  id: "hg-history",
  name: "Mercurial history",
  detect: () => null,
  history: {
    async open() {
      return {
        async read({ signal }) {
          signal?.throwIfAborted();
          return { commits: [], done: true };
        },
        close() {},
      };
    },
    planReview(commit) {
      return commit.parentRevisionIds[0]
        ? {
            kind: "revision-range",
            fromRevisionId: commit.parentRevisionIds[0],
            toRevisionId: commit.revisionId,
          }
        : { kind: "revision-show", revisionId: commit.revisionId };
    },
  },
});
```

The snippet above demonstrates static history production only; it is not a complete interactive
adapter. Add a `revision-show` operation for `revision-show` actions and a `working-tree-diff`
operation that accepts `rangeEndpoints` for `revision-range` actions before advertising interactive
opening. Otherwise Enter reports that the corresponding review operation is unsupported.

History is deliberately separate from patch-producing `operations`. The built-in host owns command
routing, graph planning, themes, terminal lifecycle, and static/interactive presentation. The
adapter owns every repository semantic: traversal and filtering, immutable identities, refs, and
`planReview`'s decision about how roots and merges open through that adapter's ordinary review
operations. Hunk treats revision ids as opaque strings and never invents provider revision syntax.

Commits must carry an immutable full `revisionId`, display id, ordered parent ids, subject, optional
message body, author (and optional email), ISO authored time, and structured ref decorations. The
optional `logicalId` identifies the same logical change across provider rewrites (for example, a
Jujutsu change id); Hunk treats it as metadata and continues to key graph and review operations by
immutable `revisionId`. A `head` decoration carries an optional `attachedLocalBranch`; use that field
rather than embedding an arrow or branch identity in its display label.

Every source must emit commits in **child-before-parent topological order**. If both a child and one
of its parents are included, the child appears first. This invariant spans the source's complete
lifetime: page boundaries do not reset it, and a parent returned on one page cannot be followed by
its child on a later page. Reads may return at most the requested limit and must distinguish a page
boundary from repository end with `done`. Hunk copies and validates every page, strips terminal
controls from display metadata, rejects duplicate revisions and parent-before-child output across
pages, forwards cancellation, and closes the source at EOF or failure.

The bundled Git and Jujutsu extensions implement this public capability today; Sapling currently
reports it as unsupported. Jujutsu supplies commit/change identities, bookmarks, tags, traversal,
and native merge-review semantics without routing through a colocated Git repository. Third-party
adapters use exactly the same contract.

Every operation `load` receives `context.signal`. Use asynchronous subprocess
APIs, pass cancellation through, and terminate plus reap provider processes when
it aborts; a synchronous spawn blocks Hunk's renderer and prevents the abort
handler from running. Watch signatures remain synchronous because the watch
runtime calls them as short, noninteractive probes.

A `load` result is patch text plus how to label it. Everything else on it is
optional, and each optional field buys one thing:

| Field            | What it adds                                                       |
| ---------------- | ------------------------------------------------------------------ |
| `untrackedPaths` | files your VCS calls unknown, synthesized into added-file diffs    |
| `readFileSource` | exact whole-file contents, for context expansion and highlighting  |
| `sourceCacheKey` | stable source-snapshot identity for highlight reuse across reloads |
| `extraFiles`     | files reviewed outside the patch, including skipped placeholders   |

`untrackedPaths` is the shorthand: list the repo-root-relative paths your VCS
reports as unknown and Hunk synthesizes the added-file diffs for you, skipping
binaries and files too large to render. Honor `input.options.excludeUntracked`
when you do, so `--exclude-untracked` still means what it says. The other two
are covered below.

#### Detection order

Detection prefers the **nearest** checkout: a Git repository nested inside a jj
workspace is reviewed as Git, whatever the priorities say. The same rule covers
your adapter — a Mercurial checkout inside a Git repository is reviewed as
Mercurial. `detectionPriority` only decides which backend wins when several
recognize the _same_ directory — the colocated case, where one working copy
carries two sets of markers.

| Adapter                  | Priority                                     |
| ------------------------ | -------------------------------------------- |
| bundled `jj`             | 200                                          |
| bundled `sl`             | 100                                          |
| bundled `git`            | 0 (`HUNK_VCS_DETECTION_BASELINE_PRIORITY`)   |
| your adapter, by default | -100 (`HUNK_DEFAULT_VCS_DETECTION_PRIORITY`) |

Higher is consulted first; equal priorities fall back to registration order.
jj and Sapling sit above Git because a colocated jj repository — or a Sapling
repository created with `sl init --git` — also carries Git metadata, and the
Git view is the wrong one.

The default puts your adapter below Git, so installing an extension never
silently changes how an existing repository is reviewed. Set
`detectionPriority` explicitly to outrank a shipped backend; it is your machine.

```ts
import { HUNK_VCS_DETECTION_BASELINE_PRIORITY } from "hunkdiff/extension";

hunk.registerVcsAdapter({
  id: "hg",
  name: "Mercurial",
  detectionPriority: HUNK_VCS_DETECTION_BASELINE_PRIORITY + 10,
  detect,
});
```

Detection runs the same way for every adapter, whichever tier registered it:
the nearest checkout wins, `detectionPriority` breaks ties between adapters
that recognize the same root, and equal priorities fall back to registration
order. Config resolves the session's VCS before your extension has been
imported, so detection runs again once extensions are loaded — with the full
adapter list — and that second answer is the one the session uses.

What detection never overrides is an explicit choice: a `vcs = "<id>"` in Hunk
config naming a backend this session loaded is honored as-is, however near a
checkout some other adapter finds. A repository-local adapter can bootstrap a
provider Hunk has never seen because `.hunk` itself establishes the project root;
global, config-path, and `--extension` adapters also participate in a staged
root/config pass before the review loads. When the final root only adds repo
candidates, Hunk extends the provisional registry instead of executing its
already loaded factories again. If repo config changes an existing extension's
factory config, Hunk sends that provisional instance `shutdown` before rebuilding it.

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

#### Exact file sources

A patch carries the changed lines and a little context, and nothing else. If
your VCS can produce a file's _whole_ contents on each side, say so with
`readFileSource` and Hunk will expand context past the hunk, highlight against
the real file, and word-diff accurately.

```ts
async load(input, ctx) {
  // Pin the revisions while the operation loads, then close over them: by the
  // time Hunk asks for a file, nothing can have moved underneath it.
  const [oldRev, newRev] = await resolveHgRevisions(input, ctx.cwd);

  return {
    repoRoot: ctx.cwd,
    sourceLabel: ctx.cwd,
    title: "Mercurial working copy",
    patchText: await runHgDiff(ctx.cwd),
    sourceCacheKey: `${oldRev}:${newRev}`,
    readFileSource: async ({ path, previousPath, changeType, side }) => {
      if (side === "old") {
        return changeType === "new" ? null : hgCat(oldRev, previousPath ?? path);
      }
      return changeType === "deleted" ? null : hgCat(newRev, path);
    },
  };
}
```

Return `null` for a side that has no content — the old side of an added file, a
path the revision never contained — rather than throwing. Return
`{ kind: "too-large", maxBytes }` when fetching the source would exceed your
resource limit; Hunk shows expansion as unavailable without treating the result
as an extension failure. Hunk calls the reader
**at most once per file and side** and caches what it resolves, so you do not
need your own cache, and it never calls it for a file the diff reports as
binary. When equivalent reloads close over the same source base, return the same
opaque `sourceCacheKey` so Hunk can reuse its highlighted output. An equal per-file
patch plus that key must guarantee equal old/new source answers for the file; change
it when source state outside the patch changes. Omit it when the adapter cannot prove
stable identity and Hunk will invalidate conservatively. Leaving
`readFileSource` off is fine: Hunk falls back to the content the patch itself carries,
which renders the same diff with less context available.

#### Files outside the patch

`extraFiles` lists files to review that your `patchText` does not contain, in
the order they should appear. Each entry is one of two kinds, and Hunk builds
the diff model for both — you describe files, you never assemble them.

A **patch** entry is a file with its own one-file diff. Reach for it when your
VCS produces better text for a file than Hunk reading the working copy would —
its own binary detection, its own path quoting:

```ts
extraFiles: [
  {
    kind: "patch",
    path: "notes.md",
    patchText: await hgDiffOneFile("notes.md"),
    isUntracked: true,
  },
];
```

A **skipped** entry is a file Hunk should list but not render. Reviewing a
multi-hundred-megabyte generated file costs more than it is worth, so report the
file and why instead of producing a diff nothing will read:

```ts
extraFiles: [
  {
    kind: "skipped",
    path: "dist/bundle.js",
    reason: "too-large",
    changeType: "change",
    stats: { additions: 100_001, deletions: 0 },
    statsTruncated: true,
  },
];
```

`readFileSource` covers the patch entries too; a skipped entry has no content to
read, so it never gets a source reader.

`untrackedPaths` remains the shorthand for the common case: list the paths your
VCS calls unknown and Hunk synthesizes the added-file diffs from the working
copy, skipping binaries and files too large to render. Use `extraFiles` instead
only when your VCS renders those files better than a plain read would.

#### Moved lines

`input.options.colorMoved` is true when the user asked for move detection.
Hunk reads move classes back out of the patch itself, so emit ANSI-colored diff
text painting moved additions cyan and moved deletions magenta — what
`git diff --color-moved` produces — and those lines render as moved. This is
ordinary post-processing over whatever patch text an adapter returns, not a Git
special case. A backend with no notion of moved lines can ignore the option.

#### Failures the user can fix

Throw a `HunkExtensionUserError` when the problem is how Hunk was invoked rather
than a bug — no repository here, an unresolvable revision, a missing binary.
Hunk prints the message without a stack trace and lists the suggestions beneath
it. Anything else is reported as an unexpected error.

```ts
import { HunkExtensionUserError } from "hunkdiff/extension";

throw new HunkExtensionUserError("`hunk stash show` is not supported by Mercurial.", {
  suggestions: ["Use `hunk show <rev>` to review a commit instead."],
});
```

Hunk detects this structurally — an object whose `name` is
`"HunkExtensionUserError"` with an optional `suggestions` array of strings — so a
plain-JavaScript extension, or one bundling its own copy of the class, is
treated the same way. `HUNK_EXTENSION_USER_ERROR_NAME` is exported if you would
rather not hard-code the string. Hunk's own bundled Git, Jujutsu, and Sapling
backends raise their failures exactly this way.

### `hunk.registerPane(pane)`

Render a React component on the `left`, `right`, `top`, or `bottom` edge of the
review. Pair it with `registerCommand` so a key opens it:

```tsx
// ~/.config/hunk/extensions/flat-pane.tsx
import { useMemo } from "react";
import type { ExtensionPaneProps, HunkExtensionAPI } from "hunkdiff/extension";

function FlatPane({ files, selectedFileId, theme, actions }: ExtensionPaneProps) {
  const ordered = useMemo(() => [...files].sort((a, b) => a.path.localeCompare(b.path)), [files]);

  return (
    <scrollbox scrollY={true} width="100%" height="100%">
      {ordered.map((file) => (
        <text
          key={file.id}
          content={` ${file.path}  +${file.stats.additions} -${file.stats.deletions}`}
          style={{
            fg: file.id === selectedFileId ? theme.accent : theme.text,
            bg: theme.panel,
          }}
          onMouseDown={() => actions.selectFile(file.id)}
        />
      ))}
    </scrollbox>
  );
}

export default function (hunk: HunkExtensionAPI) {
  hunk.registerPane({
    id: "flat",
    title: "Flat files",
    placement: "right",
    component: FlatPane,
  });
  hunk.registerCommand({ id: "toggle-flat", title: "Toggle flat pane", key: "ctrl+f" }, (ctx) => {
    ctx.panes.toggle("flat");
  });
}
```

`placement` defaults to `"left"`. Left/right panes use `width`; top/bottom panes
use `height`. Both accept `{ preferred, min?, max?, fraction? }`; equal bounds
make a fixed pane. Defaults are `{ preferred: 34, min: 22 }` columns and
`{ preferred: 8, min: 3 }` rows.

`fraction` opts into live responsive sizing until the user drags the divider. It
must be greater than `0` and at most `1`; Hunk rounds that fraction of the full
host body width or height to a terminal cell, then applies `min`, `max`, and the
space required by the review. `preferred` remains the fixed-cell target when
`fraction` is omitted. A divider drag establishes a session-local cell override:
later terminal shrink may clamp it temporarily, and expanding restores it.
Panes without `fraction` retain their fixed preferred startup size. Folder
extensions that use `fraction` should declare `"hunk": { "apiVersion": 12 }` in
their manifest.

Use `defaultOpen` to open a pane initially, `replaces: "hunk:files"` to replace
the initial files pane (and override `defaultOpen`), and `available(context)` to
hide it conditionally. One pane may replace each named target; the first
registration owns that slot and later claims are skipped with a warning.
`replaces` may also name another pane by its fully qualified
`"<extensionId>:<paneId>"` key, and Hunk follows those replacement chains.
Both `available(context)` and the mounted component receive `review`: immutable
metadata supplied by a delegated patch command, or `null` for ordinary reviews.
The bundled `hunk:review-info` top pane uses this to show change-request identity
without taking any rows when no change-request descriptor exists. Pane extensions that read
`review` should declare `"hunk": { "apiVersion": 17 }` in their manifest so older Hunk versions
refuse them cleanly instead of mounting with an incomplete prop contract.

`onActivate()` observes a primary mouse press anywhere in the pane's content,
including content nested in a `<scrollbox>`. Use it to focus an extension-owned
editor or update pane-local active state without adding mouse handlers to every
row. Hunk does not stop propagation or prevent the press, so extension-local
mouse behavior can continue. Other mouse buttons do not activate the pane. A
thrown or rejected callback is contained and reported as an attributed warning.

`hunk:files` is a named role, not a left-edge location. The
`hunk.view.toggleFilesPane` command (`s` by default) and **View → Files pane**
follow the resolved owner of that slot, whether the replacement is on the left,
right, top, or bottom. They toggle only that owner; independently registered
panes keep their own open state. User remaps and unbindings of
`hunk.view.toggleFilesPane` apply to the resolved slot in the usual way. The
former `hunk.view.toggleSidebar` id remains a compatibility alias.

`currentLine: true` opts into the selected-row painter. `currentLine.render(side, width)`
paints one side as a clipped row; `currentLine.side` and `currentLine.line` are
the same public source address command handlers see on `ctx.selection.currentLine`
(context rows use Hunk's canonical new-side). The installable
[Hunk Lens](https://github.com/modem-dev/hunk-lens) extension uses the painter; a
blame or diagnostic pane can use the address without waiting for a keypress.
Install the lens with `hunk extension install modem-dev/hunk-lens`.

Import `react` normally — Hunk serves its own React instance to extension files
at import time, so hooks, context, and JSX all run on the reconciler drawing the
rest of the app. **Never bundle or vendor a copy of React into an extension**: a
second React means a second hooks dispatcher, and the component will fail to
render. OpenTUI elements (`box`, `text`, `scrollbox`, ...) are plain intrinsic
elements and need no import.

The component receives fresh props as the app changes:

| Prop                | What it is                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review`            | immutable delegated review metadata (`change-request`, `commit`, or `comparison`), or `null` for ordinary reviews                                                         |
| `files`             | the visible reviewed files, review-stream order, filtered, frozen views (each carries `changeType`, `statsTruncated`, and `hunks` summaries beside the usual file fields) |
| `selectedFileId`    | the selected file, or `null`                                                                                                                                              |
| `selectedHunkIndex` | the selected hunk within that file, or `null`                                                                                                                             |
| `placement`         | the accepted terminal edge                                                                                                                                                |
| `width`             | exact terminal columns in the host-owned rectangle                                                                                                                        |
| `height`            | exact terminal rows in the host-owned rectangle                                                                                                                           |
| `currentLine`       | selected-row painter plus `{ side, line }` when the registration opts in, otherwise `null`                                                                                |
| `theme`             | hex color tokens from the active theme, updated on theme switch                                                                                                           |
| `keybindings`       | the current command bindings, resolved from defaults and the user's `[keybindings]` table                                                                                 |
| `actions`           | navigation and notifications the pane may trigger                                                                                                                         |

API-v3 sidebar names remain as deprecated aliases: use `registerPane`,
`ExtensionPane*`, `ctx.panes`, and `replaces: "hunk:files"` in new code.

`actions.selectFile(fileId)`, `actions.selectHunk(fileId, hunkIndex)`, and
`actions.revealLine(fileId, side, line)` route through the same review
controller as the built-in files pane and the keyboard shortcuts, so the review
stream scrolls, selection updates, and the `selection_changed` event fires
exactly as if the user had clicked a built-in row. `actions.notify(message,
type?)` shows a toast attributed to your extension. An action given a file id
that is not currently visible is refused with a warning rather than corrupting
the selection. A pane's `actions` carry the same navigation methods a command
handler's [`ctx.navigation`](#navigating-the-review) does, with the same
guarantees.

The three hunk surfaces line up by design: each file's `hunks` lists public
`ExtensionDiffHunk` summaries (`index`, the `@@` header, inclusive old/new
line spans) in render order, `selectedHunkIndex` reports the same index, and
`actions.selectHunk(fileId, hunkIndex)` accepts it. That is everything a hunk
checklist, a per-hunk progress view, or an agent-annotation navigator needs —
match an annotation's `oldRange`/`newRange` against the summaries' spans to
find its hunk — without touching the opaque `metadata`.

A component that owns a key event should ask the injected `keybindings`
manager about a **command id**, rather than hard-coding the command's default
chord. Like Pi's injected `KeybindingsManager`, this keeps local component
behavior synchronized with the user's remaps and unbindings:

```ts
import type { ExtensionKeyEvent, ExtensionPaneProps } from "hunkdiff/extension";

export function handlePaneKey(props: ExtensionPaneProps, key: ExtensionKeyEvent) {
  const nextFile = props.files[1];
  if (nextFile && props.keybindings.matches(key, "hunk.review.nextFile")) {
    // The user may have remapped this from `.` to another chord.
    props.actions.selectFile(nextFile.id);
  }
}
```

`keybindings.getKeys(commandId)` returns the current chord list for a label or
hint; unknown and unbound commands return an empty list. `matches(key,
commandId)` returns `false` for those commands too. The manager includes both
Hunk commands and extension commands under their documented ids, and its key
event argument is structural — OpenTUI's `KeyEvent` works directly.

`matchesKey`, `parseKeyChord`, and `matchesKeyChord` remain exported for
extension-local keys that intentionally are not commands. Prefer a named
command whenever a shortcut should be user-remappable.

Hunk owns pane geometry, dividers, and responsive omission. Render failures are
contained to that pane; a failed `hunk:files` replacement restores file
navigation.

Props carry the pane's exact `width` and `height`. Use a `<scrollbox>` ref for
scroll position and selection following; Hunk serves the matching
`@opentui/core` instance to extensions.

#### Scrolling: the scrollbox ref contract

The one behavior a list pane always ends up needing is following the
selection. Give your rows stable `id` props, hold a ref to the scrollbox, and
scroll the selected row into view from an effect:

```tsx
import { useEffect, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ExtensionPaneProps } from "hunkdiff/extension";

function HunkList({
  files,
  selectedFileId,
  selectedHunkIndex,
  theme,
  actions,
}: ExtensionPaneProps) {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Follow policy is deliberately yours: the host never scrolls a pane it
  // cannot see into, so decide here when (and whether) to follow.
  useEffect(() => {
    if (selectedFileId !== null) {
      scrollRef.current?.scrollChildIntoView(`row-${selectedFileId}-${selectedHunkIndex ?? 0}`);
    }
  }, [selectedFileId, selectedHunkIndex]);

  return (
    <scrollbox ref={scrollRef} width="100%" height="100%" scrollY={true} focused={false}>
      {files.flatMap((file) =>
        (file.hunks ?? []).map((hunk) => {
          const selected = file.id === selectedFileId && hunk.index === selectedHunkIndex;
          return (
            <box
              key={`${file.id}:${hunk.index}`}
              id={`row-${file.id}-${hunk.index}`}
              style={{ width: "100%", height: 1 }}
              onMouseUp={() => actions.selectHunk(file.id, hunk.index)}
            >
              <text
                content={` ${file.path}  ${hunk.header}`}
                style={{ fg: selected ? theme.accent : theme.text }}
              />
            </box>
          );
        }),
      )}
    </scrollbox>
  );
}
```

The ref surface this recipe stands on is the exact one the built-in files pane
runs on:

- **`scrollChildIntoView(id)`** scrolls the descendant with that `id` prop
  into view.
- **`scrollTop`** and **`viewport.height`** read the current scroll offset and
  the scrollbox's live viewport rows. A read before the first layout pass
  reports `0`, so viewport-dependent code belongs behind the events below
  rather than a bare mount effect.
- **`verticalScrollBar.on("change", handler)`**,
  **`viewport.on("layout-changed", handler)`**, and
  **`viewport.on("resized", handler)`** report scrolling and pane resizes;
  unsubscribe with the matching `.off` in your effect's cleanup.

That is enough to window a long list yourself: the built-in files pane renders
only the rows near the viewport, plus spacer boxes sized from those same
reads (its render-window helper is host code, but nothing it computes needs
anything beyond this surface — `useTerminalDimensions` from `@opentui/react`
serves as its pre-first-layout viewport estimate).

One honest caveat: this contract rides on OpenTUI's renderable API, served at
whatever version Hunk pins — a wider surface than `hunkdiff/extension` itself.
The built-in files pane uses the same calls, so changes that break this contract
break Hunk first. Keep scroll handling small and behind your own helpers.

Its implementation lives in `src/extensions/default/ui/sidebar/` and serves as
the reference for third-party panes.

#### Pane state from events

Lifecycle handlers run outside React, but a pane component only rerenders
when React sees a change. The recipe that connects them is a module-local store
read through `useSyncExternalStore`: the event handler updates the store, and
any mounted component subscribed to it rerenders — while the store keeps
accumulating even when the pane is closed.

```tsx
import { useSyncExternalStore } from "react";
import type { HunkExtensionAPI } from "hunkdiff/extension";

let viewedPaths: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function markViewed(path: string) {
  if (viewedPaths.has(path)) return;
  viewedPaths = new Set(viewedPaths).add(path); // new reference, so React sees the change
  for (const listener of listeners) listener();
}

function useViewedPaths() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => viewedPaths,
  );
}

function ViewedCount() {
  const viewed = useViewedPaths();
  return <text content={`${viewed.size} files viewed`} />;
}

export default function (hunk: HunkExtensionAPI) {
  hunk.on("file_viewed", ({ file }) => markViewed(file.path));
  hunk.registerPane({ id: "progress", component: ViewedCount });
}
```

Snapshots must be immutable — replace the set instead of mutating it, so
`useSyncExternalStore` can compare references. Storing state in a hook inside
the component instead would lose it every time the pane closes and unmounts.

### `hunk.registerFileView(view)` (experimental)

A file view is an alternate **host-rendered** presentation of one file in the
same top-to-bottom review stream. It is not a whole-file React component: Hunk
owns row measurement, scrolling/windowing, hunk navigation, and fallback to
Pierre's raw diff. A constrained, experimental
[fixed-height JSX row POC](file-view-jsx-poc.md) lets individual validated rows
paint OpenTUI content without taking over that geometry. Raw is always the
default; users select a matching view from **View** for the selected file.
Rows may bind themselves to exact old/new source ranges so Hunk can insert its
own inline review-note cards without giving the extension note contents or
geometry.

The installable
[`examples/extensions/rendered-markdown/`](../examples/extensions/rendered-markdown/)
uses this contract for a parsed Markdown preview. It is intentionally not bundled
or loaded by default; copy the folder into `~/.config/hunk/extensions/`, install
its dependency there, and its View entry and `F8` command become available.

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.registerFileView({
    id: "plain-markdown",
    title: "Plain Markdown",
    matches: (file) => file.path.endsWith(".md"),
    async layout(input) {
      const document = await input.readDocument("new");
      if (!document || document.length > 100_000) return null;

      const sourceLines = (document.endsWith("\n") ? document.slice(0, -1) : document).split("\n");
      const rows = sourceLines.map((text, index) => ({
        id: `line:${index + 1}`,
        spans: [{ text: text || " " }],
        sourceRanges: [{ side: "new" as const, range: [index + 1, index + 1] as const }],
      }));
      if (rows.length === 0) return null;

      return {
        rows,
        hunkRows: (input.file.hunks ?? []).map((hunk) => ({
          startRow: Math.max(0, (hunk.newRange?.[0] ?? 1) - 1),
          endRow: Math.min(rows.length - 1, (hunk.newRange?.[1] ?? 1) - 1),
        })),
      };
    },
  });
}
```

`layout` receives one readonly input containing `file`, `width`, `signal`,
`changes`, and `readDocument`. `input.file` is the same frozen public
`ExtensionDiffFile` panes receive. `input.changes` exposes typed added and
removed ranges without Pierre metadata;
complete old/new hunk ranges remain available through `input.file.hunks`.
`readDocument("old" | "new")` is lazy and cached by Hunk; it resolves exact
text or `null` when that side is absent, unavailable, too large, or fails to
load. Never treat `null` as an exception: return `null` from `layout` to keep
raw diff active.

Layouts use an omitted tone for ordinary text and generic symbolic tones
(`muted`, `accent`, `accent-muted`, `syntax`, `added`, `removed`) plus optional
terminal attributes (`bold`, `italic`, `underline`, `strikethrough`). Hunk
resolves those primitives only while painting, so the host does not learn the
extension's content format and measurement remains theme-independent. Every
parsed hunk needs one in-bounds, inclusive `hunkRows` entry at the same array
position as `input.file.hunks`.

A row's optional `sourceRanges` contains inclusive, one-based exact-source
bindings such as `{ side: "new", range: [12, 18] }`. Hunk reads only the bound
source sides, verifies every range is in bounds, rejects overlapping ranges on
the same side across rows, and requires each bound row to belong to exactly one
`hunkRows` extent. One source line and one bound row therefore resolve to one
presentation/hunk target. Inline notes anchor by their existing preferred-side start
line and are inserted before the bound row. Placement is **all-or-raw** per
file: if any visible note is range-less or unbound, Hunk temporarily renders
the complete raw diff rather than guessing or dropping review data. The stored
presentation selection returns when the note layer is hidden or the mapping
becomes resolvable. Draft note editing remains raw-only.

Invalid, oversized, cancelled, or throwing layouts are isolated with one
warning per concrete extension registration and fall back to raw diff. Rapid width changes are coalesced, and Hunk never paints
geometry measured for a stale width. An experimental custom row keeps symbolic
fallback spans and declares its fixed painter
atomically as `component: { height, render }`. Painter props include the same
curated semantic `theme` palette as custom panes. It updates live at paint
time without entering `layout` or changing deterministic geometry. If painting
fails, the fallback spans are clipped to that same declared height rather than
changing stream geometry. Custom rows are non-focusable
paint surfaces: registered commands are their supported keyboard path. A
cooperatively delivered, handled left-button mouse-up may act and stop
propagation, while wheel, drag, and unhandled input remain host-owned. Hunk
makes no portal, renderer, focus, or input-delivery guarantee; see the linked
JSX POC for state lifetime, clipping, and error boundaries. The opt-in
[`jsx-file-view-gallery`](../examples/extensions/jsx-file-view-gallery/) runs
fixed JSX rows against checked-in TypeScript, CSS, and package dependency diffs.

A command handler can control the selected file's view through
`ctx.fileViews.select("view-id")`, `toggle("view-id")`, and
`isActive("view-id")`; pass `null` to `select` to restore raw rendering.
Bare ids address the calling extension; use `"other-extension:view-id"` to
address another registered view. The public command API remains current-file
only. When the current file already uses an alternate presentation, **View →
Apply “…” to all matching files** applies it to every file in the complete
changeset that passes that view's `matches` function, including files hidden by
the current filter. Nonmatches retain their existing choices, and host
constraints such as an active draft may temporarily keep a selected file raw.

`ctx.fileViews.refresh("view-id")` invalidates that view's prepared layouts.
Hunk treats `layout` as a pure derivation of `(file, width)` and reuses a
prepared result until one of those changes, so a view holding its own state — a
fold, a toggled overlay, a display mode — has nothing to change and would
otherwise keep painting its first answer. Flip the state, then ask for the
re-derivation:

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  let expanded = false;

  hunk.registerFileView({
    id: "outline",
    title: "Outline",
    matches: (file) => file.path.endsWith(".ts"),
    layout: ({ file }) => ({
      rows: (file.hunks ?? []).map((entry) => ({
        id: `hunk:${entry.index}`,
        spans: [{ text: expanded ? `Hunk ${entry.index + 1} · ${entry.header}` : entry.header }],
      })),
      hunkRows: (file.hunks ?? []).map((entry) => ({ startRow: entry.index, endRow: entry.index })),
    }),
  });

  hunk.registerCommand(
    { id: "toggle-detail", title: "Toggle outline detail", key: "f9" },
    (ctx) => {
      expanded = !expanded;
      ctx.fileViews.refresh("outline");
    },
  );
}
```

Refresh defaults to view-wide, not current-file: every file presenting the view
re-runs `matches` and `layout`, while files on raw diff or on another view do no
work. The rows already on screen stay there until their replacement resolves, so
a refresh never flashes back to raw diff mid-flight; a re-layout that declines,
throws, or times out falls back to raw exactly like any other failed layout.
Unknown ids warn and do nothing, and ids resolve the same way `select` resolves
them.

When the state that changed belongs to one file rather than the whole view — a
fold, a per-file edit buffer — scope the invalidation with `{ fileId }` so the
other files presenting the view keep their prepared rows:

```ts
const folded = new Map<string, boolean>();

hunk.registerCommand({ id: "fold", title: "Fold this file", key: "f10" }, (ctx) => {
  const fileId = ctx.selection.file?.id;
  if (!fileId) return;
  folded.set(fileId, !folded.get(fileId));
  ctx.fileViews.refresh("outline", { fileId });
});
```

That matters because **View → Apply “…” to all matching files** can leave one
view presenting every matching file in the changeset, and each of those files
would otherwise re-run third-party `layout` for a change only one of them made.
A `fileId` no reviewed file carries invalidates nothing and warns about nothing,
since ids can race a reload.

#### Interactive file views

Add a `mode` when a file view needs keyboard input. Hunk sends it keys after
focused inputs and dialogs, but before app commands.

```ts
let showPath = true;

hunk.registerFileView({
  id: "outline",
  title: "Outline",
  matches: () => true,
  layout: ({ file }) => ({
    rows: [{ id: "summary", spans: [{ text: showPath ? file.path : "Outline" }] }],
    hunkRows: [],
  }),
  mode: {
    onKey: (key, ctx) => {
      if (key.name !== "space") return "pass";
      showPath = !showPath;
      ctx.fileViews.refresh("outline");
      return "handled";
    },
  },
});

hunk.registerCommand({ id: "outline-keys", title: "Outline keys", key: "f9" }, (ctx) => {
  ctx.fileViews.enterMode("outline");
});
```

`enterMode(viewId)` selects the view and starts its mode, returning `false` if it
cannot. Only one file-view mode runs at a time. `exitMode()` stops it;
`isModeActive(viewId)` checks it.

`onKey` must return synchronously:

- `"handled"` consumes the key.
- `"pass"` continues through any active session keyboard mode, then Hunk's
  commands and focused scrolling.
- `"exit"` consumes the key and stops the mode.

When the file-view mode is the highest-priority input owner, Escape exits it and
never reaches `onKey`. Hunk also exits when the selected file, active presentation,
extensions, or review session changes. Optional `onEnter` and `onExit` lifecycle
callbacks must also return synchronously, and `onExit` runs exactly once per
activation. A failing or asynchronous `onEnter` or `onKey` exits the mode; any
callback failure warns without breaking the review.

### `hunk.registerLineHighlighter(highlighter)`

A line highlighter marks **character ranges inside Hunk's own diff rendering**
— syntax highlighting, word diff, and layout stay exactly as they are, and the
marked characters get a resolved background. It is the lever for search hits,
diagnostics mapped onto changed lines, secret scanning, coverage, and anything
else that wants to say “these exact characters, here.”
For a whole alternate presentation, use `registerFileView` instead.

```ts
import type { ExtensionLineHighlight, HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.registerLineHighlighter({
    id: "todos",
    highlight({ file }) {
      const marks: ExtensionLineHighlight[] = [];
      let newLine = 0;
      for (const raw of file.patch.split("\n")) {
        const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
        if (header) {
          newLine = Number(header[1]);
          continue;
        }
        if (newLine === 0 || raw.startsWith("-")) continue;
        const start = raw.slice(1).indexOf("TODO");
        if (start !== -1) {
          marks.push({ side: "new", line: newLine, range: [start, start + 4], tone: "warning" });
        }
        newLine += 1;
      }
      return marks;
    },
  });
}
```

Marks are addressed by **source coordinates**, never by rendered rows: `side`
(`"old"` or `"new"`), a 1-based `line` on that side, and a `[start, end)`
range in UTF-16 code units of the line's raw text — exactly what `indexOf` and
`RegExp.exec` return against `file.patch` lines or a `readDocument` result.
That addressing survives split vs stack layout, line wrapping, horizontal
scrolling, and collapsed-context expansion, and the extension never learns
Hunk's row model. A context line may be addressed through either side's line
number; split view mirrors the mark onto both halves of the row. Offsets that
land inside an emoji or a wide character widen outward to the whole glyph. A
mark paints terminal columns, so a range covering only characters that occupy
no column — bidi controls, zero-width spaces and joiners — paints nothing.

The `tone` says what a mark means — `"match"` (the default), `"current"` for
the one hit a search is standing on, `"info"`, `"warning"`, `"error"`, or
`"dim"`. Tones exist because a **color would be the extension's problem to get
right and it cannot be**: a fixed background that reads on a context line is
invisible on an added line's green. Hunk resolves each tinted tone against the
actual background of each marked line until it clears a minimum perceptual
distance — stronger than its own word-diff emphasis, backing off only before
the code on top would stop being readable — per theme, so a mark is never
invisible on a line kind or a theme. `"dim"` recedes the marked text toward the
line background (blending token foregrounds ~45% into the line background while
preserving token hues) with a guaranteed readability floor, ideal for
review-progress workflows (e.g. marked-as-reviewed hunks) or noise de-emphasis.
On a transparent cell there is no color to blend against, so resolution falls
back to the theme background and then to the appearance's own extreme: the mark
still paints, chosen against the surface Hunk assumes rather than the one behind
the terminal. `"current"` renders as reverse video (theme text as the block,
theme background as the glyphs), the convention `less` and vim use for the
active hit.

`highlight({ file, signal, readDocument })` may be sync or async, and returns
the complete set of marks for one file — or `null` for none. Hunk calls it per
reviewed file, bounded by the same timeout and concurrency discipline as file
views, and treats the result as a pure derivation of the file plus an
invalidation epoch: results are cached until `ctx.highlights.refresh` bumps the
epoch or the review reloads. A search that moves to the next match flips its
own state and refreshes rather than pushing marks into the host:

```ts
hunk.registerCommand({ id: "next", title: "Next match", key: "f9" }, (ctx) => {
  ctx.highlights.refresh("todos");
});
```

Refresh defaults to highlighter-wide; pass `{ fileId }` to re-derive one
file's marks and leave the rest untouched. Bare ids address the calling
extension's own highlighter, `"other-extension:highlighter-id"` addresses any
registered one, unknown ids warn and do nothing, and a `fileId` no reviewed
file carries invalidates nothing — ids can race a reload. The same controls
are available to session keyboard modes through their context, so a prompt's
submit can refresh marks directly.

Containment matches the rest of the system. Marks addressing lines the review
is not showing — inside a collapsed gap, absent from a partial patch — are
silently invisible rather than errors; expanding a gap reveals marks addressed
into it when the file's source is loaded. Structurally invalid entries are
dropped with one warning per file; a raw result longer than 10,000 entries, or
one larger than 2,000 ranges per file or 100 per line, is rejected whole rather
than truncated silently; a highlighter whose marks would push one file past
4,000 merged ranges across every highlighter is dropped for that file;
overlapping ranges resolve deterministically with the later range winning. A throwing,
rejecting, or timed-out `highlight` costs that file's marks from that
highlighter and nothing else. Because highlights are paint-only — they change
colors, never text or geometry — the failure mode is always “no marks,” never
a broken review. Highlights render in interactive sessions only; the static
pager fallback never runs extension code.

### Session keyboard modes

Register a session-wide mode when an extension needs to interpret review keys
without replacing a pane or exposing renderer internals. Registration is inert;
a command deliberately enters the mode through its own scoped controls:

```ts
let pending = "";

hunk.registerKeyboardMode({
  id: "normal",
  title: "Vim navigation",
  onEnter: () => {
    pending = "";
  },
  onExit: () => {
    pending = "";
  },
  onKey: (key, ctx) => {
    if (key.sequence === "g") {
      if (pending === "g") {
        pending = "";
        ctx.commands.execute("hunk.review.jumpToTop");
      } else {
        pending = "g";
      }
      return "handled";
    }

    pending = "";
    if (key.sequence !== "j") return "pass";
    ctx.commands.execute("hunk.review.stepDown");
    return "handled";
  },
});

hunk.registerCommand({ id: "vim", title: "Toggle Vim navigation", key: "ctrl+v" }, (ctx) => {
  if (ctx.keyboardModes.isActive("normal")) {
    ctx.keyboardModes.exitMode();
  } else {
    ctx.keyboardModes.enterMode("normal");
  }
});
```

`ctx.keyboardModes.enterMode(id)` resolves only a mode registered by the same
extension. `exitMode()` and `isActive(id?)` likewise act only on that extension's
active mode, so one extension cannot inspect or stop another. Entering a mode
replaces the previous session mode and runs its `onExit` first. While `onEnter` or
`onExit` runs, `enterMode()` and `exitMode()` return `false`; lifecycle callbacks
reset extension-owned state but cannot change keyboard ownership. Only one session
keyboard mode runs at a time.

`onKey` returns synchronously:

- `"handled"` consumes the key.
- `"pass"` continues through ordinary Hunk commands and focused scrolling.
- `"exit"` consumes the key and leaves the mode.

The context is intentionally small: `cwd`, `notify`, live public `commands`,
activation-scoped `keyboardModes`, and `highlights` (so a prompt's submit can
refresh line marks directly). Keys are frozen plain snapshots, not OpenTUI
events. Async/throwing callbacks are contained and exit safely. When the session
mode is the highest-priority active input owner, host-owned Escape exits without
reaching `onKey`; the status badge and a host-owned **Extensions** menu item are
clickable exits too. Controls handed to a mode are activation-scoped: after that
activation exits, retained callbacks cannot inspect, stop, or replace a later mode.
An active `onKey` may deliberately enter another mode from the same extension; its
outgoing lifecycle callback cannot supersede that replacement.

Dialogs, menus, focused filter/note inputs, and interactive file-view modes run
before a session mode. A file-view mode may temporarily overlap it: the first
Escape leaves the focused file-view mode, and the second leaves the resumed
session mode. Ordinary content soft reloads preserve a session mode, while an
extension reload, registry closure, or App teardown exits it exactly once.

Multi-key grammar and numeric prefixes belong to the extension. Resolve a count,
then call `ctx.commands.execute(id, { count })` once so the host applies movement
atomically. See the dependency-free
[`vim-navigation`](../examples/extensions/vim-navigation/) example for `j`/`k`,
`gg`/`G`, hunk movement, alignment, capped counts, Ctrl chords, and a focused
`:` command line composed from a registered command plus `ctx.dialogs.input()`.

### `hunk.registerCommand(command, handler)`

Register a named command, optionally bound to a key. Commands share Hunk's
built-in dispatch table, with built-ins taking precedence.

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.registerCommand({ id: "hello", title: "Say hello", key: "ctrl+g" }, (ctx) => {
    ctx.notify("hello from a command");
  });
}
```

Key chords are `ctrl`, `alt`/`option`, `cmd`/`meta`, and `shift` joined with
`+` around a base key — a character (`"y"`, `"["`), an uppercase letter for its
shifted form (`"G"`), or a named key (`"f2"`, `"pageup"`, `"left"`). `shift`
applies to letters and named keys only: for a shifted symbol or digit, bind the
character the shift produces (`"!"`, not `"shift+1"`), since terminals report
the character rather than the combination. `ctrl+<letter>` also matches an
unnamed bare control byte; named Tab and Enter events stay distinct. An
unparsable chord fails registration. A chord already owned by a built-in or an
earlier extension stays with its owner and produces a warning. Omit `key` to
register a command with no binding.

`key` also takes a list, binding the command to every chord in it:

```ts
hunk.registerCommand({ id: "hello", title: "Say hello", key: ["ctrl+g", "f9"] }, (ctx) => {
  ctx.notify("hello from a command");
});
```

Chords are refused one at a time: if `ctrl+g` were already taken, the command
would still answer to `f9`.

Whatever an extension declares is a _default_. Users remap commands by id in the
`[keybindings]` table of their own config, extension commands included — yours
is named `"<extensionId>.<commandId>"`, while Hunk's own are `"hunk.app.quit"`
and friends. See [docs/keybindings.md](keybindings.md) for the rules; the
practical consequence is that a chord you declare may not be the chord your
command ends up on.

Every registered command is also listed in the menu bar's **Extensions** menu,
under its `title`, showing whichever key it currently answers to. The menu
appears only when something registered a command, entries are grouped by
extension in load order, and running one from the menu is the same dispatch the
key would have done — so a command with no `key`, or one whose chord was
refused, is still reachable with the mouse.

The handler fires when the key is pressed outside modal UI — dialogs, menus,
and focused text inputs own their keys first. It receives the standard context
plus `ctx.panes`, the controls for opening panes:

- `ctx.panes.open(paneId)` / `close(paneId)` / `toggle(paneId)` — a bare id
  names your own extension's pane, while a fully qualified
  `"<extensionId>:<paneId>"` key addresses any registered pane. Use
  `"hunk:files"` for the literal built-in pane. These controls address
  registrations directly; they do not resolve a replacement slot. To toggle
  whichever pane currently owns the files role,
  call `ctx.commands.execute("hunk.view.toggleFilesPane")`. Opening a left/right
  pane also reveals the sidebar area when responsive layout has hidden it;
  top/bottom pane state is independent of that area.
- `ctx.panes.isOpen(paneId)` reports the logical open preference, including
  while availability or terminal bounds temporarily omit the pane.

`ctx.selection` is where the review was pointing when the command fired — the
same selection a pane component sees in its props, so a command never has to
track `selection_changed` itself to know what the user is looking at:

```ts
hunk.registerCommand(
  { id: "show-selection", title: "Show the selected file", key: "ctrl+y" },
  (ctx) => {
    const { file, hunkIndex } = ctx.selection;
    if (!file) {
      ctx.notify("No file selected");
      return;
    }

    ctx.notify(hunkIndex === null ? file.path : `${file.path} — hunk ${hunkIndex + 1}`);
  },
);
```

`selection.file` is a frozen read-only view, identical to the entries in a
pane's `files` prop. Extensions only receive visible files, so it is `null`
when filtering hides the selected file or when no files are visible.
`selection.hunkIndex` is that file's selected hunk, and `null` whenever `file`
is — or when the file has no hunks to select. `selection.currentLine` is the
one-based `{ side, line }` source address carrying the current-line marker, or
`null` when the marker is off or the review has not settled on a rendered line.
It belongs to this file and hunk, uses Hunk's canonical new-side address for a
context row, and can be passed directly to `navigation.revealLine`. The values
are captured when the command fires: a handler that awaits still sees the
selection it was run from, not wherever the user navigated to meanwhile.

`ctx.commands` invokes Hunk's documented semantic commands through the exact same live command
table used by the keyboard, menus, and help:

```ts
hunk.registerCommand({ id: "skip-three", title: "Skip three hunks", key: "ctrl+j" }, (ctx) => {
  if (ctx.commands.isEnabled("hunk.review.nextHunk")) {
    ctx.commands.execute("hunk.review.nextHunk", { count: 3 });
  }
});
```

Only explicitly public built-in `hunk.*` commands can be invoked. Unknown, disabled,
extension-owned, or stale-session commands return `false`; an extension cannot recursively invoke
itself or another extension. `isEnabled` also returns `false` for malformed ids, while malformed
`execute` ids, options, and counts throw as extension programming errors. The public ids are the built-ins listed in
[keybindings](keybindings.md), including the unbound
`hunk.review.alignCurrentLineTop`, `hunk.review.alignCurrentLineCenter`, and
`hunk.review.alignCurrentLineBottom` commands.

`count` defaults to `1` and must be a positive safe integer no greater than `10,000`. Relative
line, viewport, horizontal, file, hunk, and annotated navigation applies the count atomically in
one host transition. Absolute positioning and one-shot commands run once. This avoids stale React
state without exposing scroll boxes, renderer refs, or coordinates. Both methods read live command
state, so they remain valid after an `await` or an ordinary content soft reload that retains the
extension registry. Controls retained across an extension-registry reload or App remount return
`false`.

`ctx.keyboardModes` enters, exits, or probes the command's own registered
session keyboard modes. See [Session keyboard modes](#session-keyboard-modes).

`ctx.highlights` refreshes prepared line-highlight marks, whole or
`{ fileId }`-scoped. See
[`hunk.registerLineHighlighter`](#hunkregisterlinehighlighterhighlighter).

#### Reading the authoritative review

`ctx.review.snapshot()` returns a deeply immutable projection of the shared
ReviewStore, or `null` after this command's review generation has been retired.
It contains the opaque producer `generation`, the store's `stateRevision`, every
file in authoritative review/sidebar order, and every saved live or reviewer
note. Files carry their stable `fileKey`, transient `runtimeId`, content identity,
paths, stats, and flags; notes carry their complete resolved old/new anchor,
optional direct `parentId`, and `active`/`stale`/`orphaned` reconciliation status.

This is the command-time source for exporters, publishers, and audit tools. Drafts
are excluded because they are not saved. Static sidecar annotations that never
entered ReviewStore remain available on the changeset's file views, not in this
snapshot. Saved notes appear in live-arrival order followed by reviewer-creation
order, including orphaned notes a publisher may need to move into a summary.

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.registerCommand({ id: "publish", title: "Publish review" }, async (ctx) => {
    const captured = ctx.review.snapshot();
    if (!captured) return;

    await Promise.resolve(); // Prepare an external request from `captured` here.
    const current = ctx.review.snapshot();
    if (
      !current ||
      current.generation !== captured.generation ||
      current.stateRevision !== captured.stateRevision
    ) {
      ctx.notify("Review changed; rebuild the request", "warning");
      return;
    }
  });
}
```

Call `snapshot()` again before irreversible asynchronous work and compare both
fields: revisions are comparable only within one generation. Use `fileKey` for
semantic addressing, `contentIdentity` to detect changed reviewed content, and
`runtimeId` only for navigation inside that exact generation. The
[`review-snapshot-export`](../examples/extensions/review-snapshot-export/)
example writes the complete value as JSON and demonstrates this stale-work check. The
[`review-note-navigator`](../examples/extensions/review-note-navigator/) example composes
the complete note inventory, authoritative anchors, a selector dialog, and guarded navigation
to currently visible files.

#### Navigating the review

`ctx.navigation` moves the review stream: `selectFile(fileId)`,
`selectHunk(fileId, hunkIndex)`, and `revealLine(fileId, side, line)`, the same
guarded navigation a pane's `actions` carry, routed through the same review
controller — the stream scrolls, selection updates, and `selection_changed`
fires exactly as if the user had clicked a pane row. Unlike `selection` it is
live, not a snapshot: a call acts on the review as it is at that moment, so a
handler that awaits a dialog and then navigates still works. A file id the
stream cannot currently show is refused with a warning rather than corrupting
the selection, and a hunk index is clamped into the file's real range.

`revealLine` is the finest target there is, and the one to reach for when your
extension knows exactly which line it means — a search hit, a lint finding, the
line a mark from [`registerLineHighlighter`](#hunkregisterlinehighlighterhighlighter)
sits on. A hunk hundreds of lines tall has one anchor, so `selectHunk` can leave
the line you meant pages below the viewport; `revealLine` scrolls to the line
itself, lands it a little below the viewport top like every other Hunk reveal,
and makes it the current line so the reverse-video marker sits on it.

`line` is 1-based on `side` as the patch numbers it, so a context line answers
to either side's number. Two things soften the target rather than failing it:
when no rendered row carries that line — it is inside a collapsed gap, absent
from a partial patch, or the reviewer turned the current-line marker off
(`view.cursor_line = "off"`) — the jump lands on the hunk containing the line
instead. Only a line no hunk of the file covers is refused, with a warning
naming your extension, and so are a side outside `"old"`/`"new"` and a line
number that is not a positive whole number.

```ts
hunk.registerCommand({ id: "first-todo", title: "Jump to the first TODO" }, async (ctx) => {
  const file = ctx.selection.file;
  if (!file) {
    return;
  }

  const document = await ctx.workspace.readDocument(file.id, "new");
  const index = (document ?? "").split("\n").findIndex((line) => line.includes("TODO"));
  if (index >= 0) {
    ctx.navigation.revealLine(file.id, "new", index + 1);
  }
});
```

A handler may be async; a failure (sync or rejected) becomes a warning naming
your extension.

#### Asking the user

`ctx.dialogs` puts a question on screen and waits for the answer. Three shapes,
all promise-returning:

- `confirm({ title, body?, confirmLabel?, cancelLabel? })` → `true` or `false`
- `select({ title, options })` → the chosen string, or `null`
- `input({ title, placeholder?, initial? })` → the typed string, or `null`

```ts
hunk.registerCommand(
  { id: "reformat", title: "Reformat the selected file", key: "ctrl+r" },
  async (ctx) => {
    const file = ctx.selection.file;
    if (!file) {
      return;
    }

    const proceed = await ctx.dialogs.confirm({
      title: `Reformat ${file.path}?`,
      body: "The file is rewritten in place.",
      confirmLabel: "reformat",
    });

    ctx.notify(proceed ? `Reformatting ${file.path}` : "Left it alone");
  },
);
```

`select` is the natural fit for acting on part of the selection — here, asking
which hunk of the selected file to jump to, then navigating there:

```ts
hunk.registerCommand({ id: "pick-hunk", title: "Pick a hunk", key: "ctrl+k" }, async (ctx) => {
  const file = ctx.selection.file;
  const hunks = file?.hunks ?? [];
  if (!file || hunks.length === 0) {
    ctx.notify("Nothing to pick from", "warning");
    return;
  }

  const labels = hunks.map((hunk) => hunk.header || `hunk ${hunk.index + 1}`);
  const picked = await ctx.dialogs.select({ title: "Which hunk?", options: labels });

  // `navigation` is live, so the jump is valid even after awaiting the dialog.
  if (picked !== null) {
    ctx.navigation.selectHunk(file.id, labels.indexOf(picked));
  }
});
```

Hunk draws the dialog, not you: your text fills the title, body, and choices,
and dialogs from installed extensions carry an `ext <your-id>` attribution line
— the same marker `notify` toasts use — so a third-party prompt can never present
itself as Hunk asking. Hunk's own bundled extensions omit that redundant marker.

One dialog is on screen at a time. Concurrent requests queue in call order,
across extensions too, so a second question waits its turn instead of replacing
the first. While a dialog is up it owns the keyboard: Escape cancels (`false`,
or `null`), Enter accepts — the confirm action, the highlighted option, or the
typed text — and review shortcuts stay suppressed underneath. Confirm dialogs
also answer to `y`/`n`, select dialogs to `↑`/`↓`, and every dialog's actions
and rows are clickable.

Two things resolve a dialog without the user: the session moving on, and bad
arguments. A session reload — the refresh key, a watch-triggered reload, an
agent command — cancels open and queued dialogs, since the review they asked
about is being replaced; a dialog pending at shutdown resolves its cancel value
the same way, and a request made after that point cancels immediately. A blank
`title`, or a `select` with no options, is a bug in the extension rather than an
answer from the user, so the promise **rejects**; like any other handler
failure, that surfaces as a warning naming your extension.

#### Workspace documents

`ctx.workspace` reads full documents from the current review and can replace an
eligible working-tree file.

| Method                                 | Result                                            |
| -------------------------------------- | ------------------------------------------------- |
| `readDocument(fileId, "old" \| "new")` | The reviewed source text, or `null`               |
| `canWriteDocument(fileId)`             | Whether the review and file allow writes          |
| `writeDocument({ fileId, text })`      | `{ ok: true }` or `{ ok: false, reason, detail }` |

A command can read, transform, and write a selected file:

```ts
hunk.registerCommand({ id: "shout-headings", title: "Shout headings", key: "f7" }, async (ctx) => {
  const file = ctx.selection.file;
  if (!file || !ctx.workspace.canWriteDocument(file.id)) return;

  const current = await ctx.workspace.readDocument(file.id, "new");
  if (current === null) return;

  const result = await ctx.workspace.writeDocument({
    fileId: file.id,
    text: current.replace(/^(#+ .+)$/gm, (heading) => heading.toUpperCase()),
  });

  if (!result.ok && result.reason !== "cancelled") {
    ctx.notify(result.detail, "warning");
  }
});
```

`readDocument` returns the exact source represented by the review, not the
file's patch. It works for every review kind. For example, the `"new"` side in
`hunk show HEAD` is the file at that commit, not the working-tree file. It
returns `null` when the file or side is absent, no source is available, reading
fails, or the document exceeds Hunk's size limit. Reads never prompt. An invalid
side rejects the promise.

Writes require all of the following:

- an unstaged working-tree review (`hunk diff` with no revision range)
- a reloadable session; `--agent-context -` sessions cannot write
- a reviewed file with writable new-side text
- a regular target inside the review root

Revision, stash, range, staged, patch, and file-pair reviews are read-only.
Deleted, binary, oversized, missing, symlinked, and root-escaping targets are
also refused. Targets are identified by reviewed file id, never by an arbitrary
path.

`canWriteDocument` checks the review and file policy without prompting or
inspecting the filesystem. A later `writeDocument` can still refuse if the file
has moved or become unsafe.

`writeDocument` verifies the target, asks for consent through the attributed
`ctx.dialogs` queue, then verifies it again before writing. The second check
prevents deletion and symlink-swap races while the dialog is open. Authority is
checked immediately before the filesystem call; once that irreversible write
starts, its actual success or failure wins even if another reload happens, and
graceful shutdown waits for it to settle. A successful write queues
reconciliation of the review then active, and the write promise may settle
before that reload finishes.

A declined prompt returns `cancelled`, an ineligible or unsafe target returns
`unavailable`, and an attempted write failure returns `failed` with a
displayable `detail`. Malformed requests reject the promise.

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
the panes and review stream both follow whatever you return.

Each file carries an opaque `metadata` field: it is the parsed diff the renderer
draws from, so pass it through untouched (spreading a file preserves it). What
you return is validated before it is reviewed. A transform that throws, or
returns something the review UI could not draw — not a changeset with a `files`
array, a file missing `metadata.hunks` or `stats`, two files sharing an `id` —
is skipped: the previous changeset carries forward and you get a warning naming
your extension and the problem.

You never need to reach into `metadata` to know what a file's hunks are: the
read-only views Hunk hands outward (event payloads, pane props, a command's
selection) carry a `hunks` list of public summaries — `index`, the `@@` header,
and the inclusive old/new line spans, in render order. Like `changeType`, it is
derived from the metadata at that boundary, so a transform neither receives nor
produces it, and a stale value spread through a transform is replaced with what
the metadata actually parses to.

### `hunk.on(event, handler)`

Subscribe to a lifecycle or UI event. Handlers may be async; Hunk never blocks
the UI waiting for one. Alongside `cwd` and `notify`, every handler receives
`ctx.panes`, live `ctx.navigation`, attributed `ctx.dialogs`, and review reload
controls. `ctx.sidebars` is a deprecated alias for `ctx.panes`. That means a `startup` handler can present
one focused welcome question and navigate to its first example, while a
`changeset_loaded` handler can reveal a pane when it finds something worth
showing — no keypress required. Dialog calls made before the mounted app is
ready resolve to their cancel value with a warning rather than opening later.
Controls retained across a review or extension-registry replacement expire:
navigation and pane mutations warn and do nothing, dialogs resolve to their
normal cancel value, and workspace reads or not-yet-started writes return
`null`/`unavailable` instead of acting on replacement content. Once a consented
filesystem write starts, it reports its actual outcome and success reconciles
the review then active.

| Event                  | Payload                 | When                                                      |
| ---------------------- | ----------------------- | --------------------------------------------------------- |
| `startup`              | `{ cwd }`               | once per loaded instance, after its review UI mounts      |
| `changeset_loaded`     | `{ changeset }`         | first load and every reload                               |
| `command_executed`     | `{ commandId }`         | after a named command dispatches in this terminal host    |
| `selection_changed`    | `{ fileId, hunkIndex }` | when the review selection settles (debounced ~150ms)      |
| `file_viewed`          | `{ file, hunkIndex }`   | when selection settles on a file or a reload replaces it  |
| `hunk_viewed`          | `{ file, hunkIndex }`   | when selection settles on a different hunk                |
| `filter_changed`       | `{ filter }`            | whenever the file-filter query changes                    |
| `theme_changed`        | `{ themeId }`           | when the user commits a new theme                         |
| `layout_changed`       | `{ mode, layout }`      | mode or responsive split/stack layout changes             |
| `watch_reload_pending` | `{}`                    | watcher observed a change before its reload check         |
| `note_created`         | `{ note }`              | a user saves an inline review note                        |
| `note_edited`          | `{ note }`              | a draft body changes or an existing note is saved         |
| `note_changed`         | `{ kind, note }`        | a saved ReviewStore note is created, updated, or removed  |
| `session_reload`       | `{ changeset, reason }` | on every session reload                                   |
| `shutdown`             | `{}`                    | before instance replacement or exit, with a short timeout |

A newly mounted extension instance receives `startup` before its first
`changeset_loaded`; reloads then deliver `changeset_loaded` before
`session_reload` once the matching review generation has committed.

`selection_changed` is trailing-debounced on purpose: holding `[`/`]` retargets
the selection many times a second, and handlers only care where the user landed.
`fileId` and `hunkIndex` are `null` when nothing is selected.

`hunk_viewed` is the hunk-grain sibling of `file_viewed`. It fires when the
settled `(file, hunk)` pair changes — including `[`/`]` inside one file — and
does not fire for current-line movement within a hunk. `file_viewed` still fires
only when the selected file object changes, so a soft reload can report a fresh
file without counting as a new hunk read.

`command_executed` reports the stable canonical command id after the terminal dispatcher invokes
it, whether the user reached it through a key, a menu, an old command alias, or
`ctx.commands.execute`. Extension commands
may still have detached async work in flight; this event observes the accepted user action, not
promise settlement. Listen for ids rather than key chords so behavior follows the user's live
`[keybindings]` table. Browser/session actions lower to shared review intents rather than terminal
commands and do not emit this event. Modal widget keys such as Escape, Enter, note-editor Ctrl-S,
and F10 menu navigation are also not commands.

`session_reload`'s `reason` is `"watch"` (the watcher saw the source change),
`"daemon"` (an agent command through the session broker), `"extension"` (an
in-process extension request), or `"manual"` (the refresh key, or the reload
after granting extension trust).

`note_created` and `note_edited` cover notes authored in Hunk's own UI, in this
session. `note_edited` carries `note.draft: true` for composer changes and
`note.draft: false` for an identity-preserving saved-note edit. Replies include their direct
`parentId`. Review notes are session-local state, so there is no backlog to replay
on startup — but comments added through agent session commands do not emit
these events, and a `session_reload` may remap or drop notes without one
either. Use them for incremental UI reactions only.

`note_changed` is the store-backed path: `kind` is `"created"`, `"updated"`, or
`"removed"`, and `note` is the same snapshot shape `ctx.review.snapshot()`
returns. It fires for user saves and deletes and for agent session comments.
Drafts never appear. A TUI save therefore emits both `note_created` (or
`note_edited`) and `note_changed`. Reloads that remap or drop notes do not emit
`note_changed`; listen for `session_reload` to invalidate extension-owned state,
then read `ctx.review.snapshot()` from a later command when it needs the complete
current saved-note record.

`shutdown` handlers get a short window (250ms) to finish before Hunk replaces
the extension registry or exits anyway, so make cleanup prompt and idempotent.
Host-mediated UI authority is already revoked when shutdown begins: use the
event to release extension-owned resources, not to navigate or open dialogs.
The replacement instance receives `startup` after its review is mounted.

### `hunk.events`

`hunk.events` is a small bus shared by every loaded extension. Use it to
coordinate extensions without coupling them through a command or global state.
Names are open-ended, so namespace them with your extension id. Listeners get
the same `ctx.panes`, `ctx.navigation`, `ctx.dialogs`, and `ctx.review` reload
controls as lifecycle handlers; `ctx.sidebars` remains a deprecated pane alias. Delivery is
fire-and-forget and one listener's failure is reported without stopping the
others. Events an
extension emits while factories are loading are queued until every extension
has had a chance to subscribe.

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.events.on<{ fileCount: number }>("summary:ready", (payload, ctx) => {
    if (payload.fileCount > 100) ctx.panes.open("summary");
  });

  hunk.on("changeset_loaded", ({ changeset }, ctx) => {
    hunk.events.emit("summary:ready", { fileCount: changeset.files.length });
    ctx.panes.open("summary");
  });
}
```

Bus payloads are shallow-frozen copies when they are objects. Keep nested data
immutable if multiple extensions will read it.

### `ctx.review.requestReload()` in event handlers

Request a soft reload of the currently mounted review after an external agent,
service, or process changes its inputs. This does not require `--watch`. Hunk
reuses the current input and live view options, preserves mounted UI state and
selection where possible, serializes the work with every other reload, and
coalesces concurrent extension requests into one operation.

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.events.on("agent:files-changed", async (_payload, ctx) => {
    const result = await ctx.review.requestReload();
    if (!result.ok) ctx.notify(result.detail, "warning");
  });
}
```

Success resolves `{ ok: true }` after the replacement review commits and emits
`session_reload` with reason `"extension"`. Non-reloadable inputs and controls
retained from an expired review resolve `unavailable`; a reload that starts but
cannot complete resolves `failed` with a displayable `detail`. Factory-time bus
events can run before the app mounts, so their reload requests are unavailable.
Once a live request starts, it reports that operation's actual result even
though a successful reload expires the context that requested it.
Requests made from the successor's lifecycle handlers are a new generation and
can schedule a trailing reload. Check `session_reload.reason` before requesting
from that event so an extension does not create its own reload loop.

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
Event and bus handlers additionally receive `panes`, `review.requestReload`, and `events.emit`; command
handlers receive `panes`, `selection`, `navigation`, and `dialogs`. The deprecated
`sidebars` alias remains available during the API-v4 compatibility window. `notify`
shows a single unobtrusive line at the bottom of the app that clears
itself after a few seconds; queued messages appear in turn. `type` is `"info"`
(default), `"warning"`, or `"error"`, which selects the color. Notifications
raised before the UI has mounted are buffered and flushed once it does, so a
`startup` handler can notify safely.

### `hunk.log(message)`

Record a diagnostic line. Logs are collected per extension rather than written
to the terminal, because the TUI owns the screen.

## A complete example

Installable extensions and examples include:

- [`pane-layout`](../examples/extensions/pane-layout/) for all four placements.
- [Hunk Lens](https://github.com/modem-dev/hunk-lens) for opaque selected-row
  paint (`hunk extension install modem-dev/hunk-lens`).
- [`review-triage`](../examples/extensions/review-triage/) for panes, commands,
  dialogs, lifecycle events, and the event bus.
- [`review-snapshot-export`](../examples/extensions/review-snapshot-export/) for
  authoritative saved-note export and generation/revision stale-work checks.
- [`examples/extensions/rendered-markdown/`](../examples/extensions/rendered-markdown/)
  parses Markdown into generic host-owned file-view rows. Its README shows how
  to run it from the checkout or copy it into the global extensions directory.

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
hunk diff --extension ./path/to/entry.ts   # load one entry file for a review (repeatable)
hunk diff --extension ./my-ext             # a folder extension: loads ./my-ext/index.ts
hunk --extension ./my-ext cli-tools status # load then run its top-level CLI command
hunk --no-extensions cli-tools status      # no discovery or import; command is unavailable
hunk diff --no-extensions                  # disable user extensions for this review
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
Git, Jujutsu, and Sapling backends load either way. `[extensions] paths` from a repo
config is trust-gated the same way `.hunk/extensions` is, because it is
repo-controlled either way.

## Not contributable yet

Menu entries, standalone keybindings (a chord contributed without a command —
commands registered through `registerCommand` **are** already user-remappable
via `[keybindings]`), custom note renderers, and session commands are not
contributable yet. Generic top-level CLI trees use `registerCliCommand`; TUI
commands and their default key bindings use `registerCommand`. See
[docs/extension-system-exploration.md](extension-system-exploration.md) for the
design and phasing.
