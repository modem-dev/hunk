# Mercurial VCS adapter extension

An installable example that teaches Hunk how to review an upstream Mercurial working copy. It registers VCS id `hg`, implements working-copy diff and revision show, and intentionally omits stash show because Mercurial has no equivalent operation.

This example is **not bundled or loaded by Hunk**, and it is not included in the `hunkdiff` npm package. Install the folder explicitly if you want it. It needs `hg` on `PATH` at runtime and otherwise depends only on Node APIs and `hunkdiff/extension`.

## Try it from this checkout

```bash
PATH=/path/to/mercurial/bin:$PATH bun run src/main.tsx -- diff \
  --extension ./examples/extensions/mercurial
```

The adapter also works with `show`:

```bash
bun run src/main.tsx -- show . --extension ./examples/extensions/mercurial
```

## Install it globally

Copy the whole folder into Hunk's user extension directory:

```bash
mkdir -p ~/.config/hunk/extensions
cp -R examples/extensions/mercurial ~/.config/hunk/extensions/
```

Hunk discovers its `package.json` on later launches. Select it explicitly with `vcs = "hg"` in Hunk config when auto-detection is not desired.

## Behavior and policy

- Detection walks upward for `.hg`. A `.hg/requires` file containing the exact line `treestate` is Sapling metadata, so this adapter declines it and lets Hunk's bundled Sapling adapter handle the checkout.
- Its priority is `HUNK_VCS_DETECTION_BASELINE_PRIORITY + 50`: above bundled Git because a colocated upstream `.hg` directory is authoritative for that working copy, but below bundled Sapling (`+100`). The explicit `treestate` check avoids relying on priority alone.
- All patch commands use `hg diff --git --nodates` under `HGPLAIN=1` and `HGENCODING=utf-8`, so output is deterministic and decoded consistently.
- Processes are spawned with argv arrays. Every path filter is passed after `--` as an explicit `path:<pathspec>` Mercurial pattern, so a leading dash or pattern-looking filename is never interpreted as an option or another pattern kind.
- `--staged` is rejected with a user-facing explanation because Mercurial has no staging area. Stash show is omitted, so Hunk reports that operation as unsupported.
- Live working-copy reviews list `hg status --unknown` paths unless `--exclude-untracked` is set. A two-committed-revision comparison does not mix current unknown files into historical output.

### Narrow range syntax

This example deliberately accepts only these forms:

| Hunk input  | Mercurial meaning                                     |
| ----------- | ----------------------------------------------------- |
| no range    | committed parent `.` to the working-copy filesystem   |
| `REV`       | `hg diff --rev REV`, from `REV` to the working copy   |
| `REV1:REV2` | `hg diff --rev REV1 --rev REV2`, both sides committed |

Open-ended ranges and strings containing more than one colon are refused rather than guessed at. `hunk show REV` uses `hg diff --change REV`; omitting `REV` defaults to `.`.

## Exact sources and watch behavior

The adapter supplies exact old/new source readers:

- committed endpoints are resolved to immutable full node ids before the operation returns and read with `hg cat`;
- a live new endpoint is read from the working-copy filesystem;
- `previousPath` is used for the old side of copies/renames;
- added old sides and deleted new sides return `null`.

Watch plans are explicitly **poll-only**. This does not claim incomplete filesystem-event coverage: Hunk recomputes a signature containing the tracked patch, pinned endpoints, and SHA-256 of every included unknown file's complete content. Consequently an unknown file rewritten to different bytes with the same size (and even the same timestamp) still reloads the review. The tradeoff is one or more Mercurial subprocesses plus unknown-file reads per poll.

## Tests

Pure argument, parser, detection, registration, environment, and error tests always run:

```bash
bun test examples/extensions/mercurial
```

The real-repository suite is opt-in and runs against the `hg` executable on `PATH` (this example was initially verified with Mercurial 7.2.4):

```bash
PATH=/tmp/hunk-hg-venv/bin:$PATH \
  HUNK_RUN_HG_INTEGRATION=1 \
  bun test examples/extensions/mercurial
```

`bun run check:pack` compiles the production `index.ts` and `commands.ts` sources against the packed `hunkdiff/extension` declarations under both NodeNext and Bundler resolution.
