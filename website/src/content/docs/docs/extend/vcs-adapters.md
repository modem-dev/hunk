---
title: VCS adapters
description: Contribute a version-control backend with detection, watch support, exact file sources, and rich failures.
---

`hunk.registerVcsAdapter(adapter)` contributes an additional VCS backend. This is the same call Hunk's own bundled Git, Jujutsu, and Sapling backends make.

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

The ids Hunk ships with — `git`, `jj`, and `sl` — are reserved. An adapter that reuses one is skipped with a notice.

`operations` is optional and may implement any of `working-tree-diff`, `revision-show`, and `stash-show`; an operation you leave out — or leaving the map off entirely — produces a clear "not supported" error for that command instead of a crash.

## History

The built-in `hunk log` surface gets all repository semantics from the selected adapter's optional
`history` capability. Hunk owns presentation, themes, graph layout, paging, and terminal lifecycle;
the adapter owns traversal, refs, immutable identities, and how a selected item opens in review.

```ts
history: {
  async open(input, ctx) {
    return openHgHistory(input, ctx);
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
```

This history fragment demonstrates static listing only. For interactive opening, the same adapter
must also register a `revision-show` operation for `revision-show` actions and a `working-tree-diff`
operation that accepts `rangeEndpoints` for `revision-range` actions. Otherwise Enter reports the
missing review operation as unsupported.

`planReview` is provider-owned because roots, merges, and revision syntax differ. Hunk treats every
revision id as opaque and routes the returned action through the same adapter's `revision-show` or
`working-tree-diff` operation.

History pages must remain in **child-before-parent topological order across the complete source**.
When both commits are returned, a child must precede its parent even when they fall on different
pages. Each read may return at most its requested limit, and `done` distinguishes a page boundary
from repository end. Hunk validates these invariants across pages.

Decorations are structured. A `head` decoration may set `attachedLocalBranch`; do not encode branch
attachment or arrow punctuation in its label. This lets Hunk render and deduplicate decorations
without parsing provider display text. An optional `logicalId` names one logical change across
provider rewrites (such as a Jujutsu change id); it is metadata, while graph and review operations
continue to use immutable `revisionId` values.

The bundled Git and Jujutsu adapters both implement this contract. Jujutsu emits immutable commit
IDs plus logical change IDs, maps bookmarks/remotes/tags to structured decorations, and uses JJ's
native single-revision diff for ordinary, merge, and root reviews. It works in both colocated and
JJ-only workspaces; no Git command or `.git` worktree is required.

A `load` result is patch text plus how to label it. Everything else on it is optional, and each optional field buys one thing:

| Field            | What it adds                                                      |
| ---------------- | ----------------------------------------------------------------- |
| `untrackedPaths` | files your VCS calls unknown, synthesized into added-file diffs   |
| `readFileSource` | exact whole-file contents, for context expansion and highlighting |
| `extraFiles`     | files reviewed outside the patch, including skipped placeholders  |

`untrackedPaths` is the shorthand: list the repo-root-relative paths your VCS reports as unknown and Hunk synthesizes the added-file diffs for you, skipping binaries and files too large to render. Honor `input.options.excludeUntracked` when you do, so `--exclude-untracked` still means what it says. The other two are covered below.

## Detection order

Detection prefers the **nearest** checkout: a Git repository nested inside a jj workspace is reviewed as Git, whatever the priorities say. The same rule covers your adapter — a Mercurial checkout inside a Git repository is reviewed as Mercurial. `detectionPriority` only decides which backend wins when several recognize the _same_ directory — the colocated case, where one working copy carries two sets of markers.

| Adapter                  | Priority                                     |
| ------------------------ | -------------------------------------------- |
| bundled `jj`             | 200                                          |
| bundled `sl`             | 100                                          |
| bundled `git`            | 0 (`HUNK_VCS_DETECTION_BASELINE_PRIORITY`)   |
| your adapter, by default | -100 (`HUNK_DEFAULT_VCS_DETECTION_PRIORITY`) |

Higher is consulted first; equal priorities fall back to registration order. jj and Sapling sit above Git because a colocated jj repository — or a Sapling repository created with `sl init --git` — also carries Git metadata, and the Git view is the wrong one.

The default puts your adapter below Git, so installing an extension never silently changes how an existing repository is reviewed. Set `detectionPriority` explicitly to outrank a shipped backend; it is your machine.

```ts
import { HUNK_VCS_DETECTION_BASELINE_PRIORITY } from "hunkdiff/extension";

hunk.registerVcsAdapter({
  id: "hg",
  name: "Mercurial",
  detectionPriority: HUNK_VCS_DETECTION_BASELINE_PRIORITY + 10,
  detect,
});
```

Detection runs the same way for every adapter, whichever tier registered it: the nearest checkout wins, `detectionPriority` breaks ties between adapters that recognize the same root, and equal priorities fall back to registration order. Config resolves the session's VCS before your extension has been imported, so detection runs again once extensions are loaded — with the full adapter list — and that second answer is the one the session uses.

What detection never overrides is an explicit choice: a `vcs = "<id>"` in Hunk config naming a backend this session loaded is honored as-is, however near a checkout some other adapter finds. A repository-local adapter can bootstrap a provider Hunk has never seen because `.hunk` itself establishes the project root; global, config-path, and `--extension` adapters also participate in a staged root/config pass before the review loads.

## Watch support

`--watch` works through extension adapters. Each operation may add:

- `watchSignature(input, ctx)` — a cheap fingerprint of the reviewed state. Hunk polls it and reloads when it changes.
- `watchPlan(input, ctx)` — the filesystem targets that cover that state, so Hunk reacts to events instead of polling on a timer.

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

`coverage: "hybrid"` promises the targets cover the reviewed state. Leaving `watchPlan` out is equivalent to `poll-only` and still works — it just costs a subprocess per tick.

## Exact file sources

A patch carries the changed lines and a little context, and nothing else. If your VCS can produce a file's _whole_ contents on each side, say so with `readFileSource` and Hunk will expand context past the hunk, highlight against the real file, and word-diff accurately.

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
    readFileSource: async ({ path, previousPath, changeType, side }) => {
      if (side === "old") {
        return changeType === "new" ? null : hgCat(oldRev, previousPath ?? path);
      }
      return changeType === "deleted" ? null : hgCat(newRev, path);
    },
  };
}
```

Return `null` for a side that has no content — the old side of an added file, a path the revision never contained — rather than throwing. Return `{ kind: "too-large", maxBytes }` when fetching the source would exceed your resource limit; Hunk shows expansion as unavailable without treating the result as an extension failure. Hunk calls the reader **at most once per file and side** and caches what it resolves, so you do not need your own cache, and it never calls it for a file the diff reports as binary. Leaving `readFileSource` off is fine: Hunk falls back to the content the patch itself carries, which renders the same diff with less context available.

## Files outside the patch

`extraFiles` lists files to review that your `patchText` does not contain, in the order they should appear. Each entry is one of two kinds, and Hunk builds the diff model for both — you describe files, you never assemble them.

A **patch** entry is a file with its own one-file diff. Reach for it when your VCS produces better text for a file than Hunk reading the working copy would — its own binary detection, its own path quoting:

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

A **skipped** entry is a file Hunk should list but not render. Reviewing a multi-hundred-megabyte generated file costs more than it is worth, so report the file and why instead of producing a diff nothing will read:

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

`readFileSource` covers the patch entries too; a skipped entry has no content to read, so it never gets a source reader.

`untrackedPaths` remains the shorthand for the common case: list the paths your VCS calls unknown and Hunk synthesizes the added-file diffs from the working copy, skipping binaries and files too large to render. Use `extraFiles` instead only when your VCS renders those files better than a plain read would.

## Moved lines

`input.options.colorMoved` is true when the user asked for move detection. Hunk reads move classes back out of the patch itself, so emit ANSI-colored diff text painting moved additions cyan and moved deletions magenta — what `git diff --color-moved` produces — and those lines render as moved. This is ordinary post-processing over whatever patch text an adapter returns, not a Git special case. A backend with no notion of moved lines can ignore the option.

## Failures the user can fix

Throw a `HunkExtensionUserError` when the problem is how Hunk was invoked rather than a bug — no repository here, an unresolvable revision, a missing binary. Hunk prints the message without a stack trace and lists the suggestions beneath it. Anything else is reported as an unexpected error.

```ts
import { HunkExtensionUserError } from "hunkdiff/extension";

throw new HunkExtensionUserError("`hunk stash show` is not supported by Mercurial.", {
  suggestions: ["Use `hunk show <rev>` to review a commit instead."],
});
```

Hunk detects this structurally — an object whose `name` is `"HunkExtensionUserError"` with an optional `suggestions` array of strings — so a plain-JavaScript extension, or one bundling its own copy of the class, is treated the same way. `HUNK_EXTENSION_USER_ERROR_NAME` is exported if you would rather not hard-code the string. Hunk's own bundled Git, Jujutsu, and Sapling backends raise their failures exactly this way.
