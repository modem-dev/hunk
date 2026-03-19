# hunk

Hunk is a desktop-inspired terminal diff viewer for understanding AI-authored changesets in Bun + TypeScript with OpenTUI.

## Requirements

- Bun
- Zig

## Install

```bash
bun install
```

## Run

```bash
bun run src/main.tsx -- git
```

## Standalone binary

Build a local executable:

```bash
bun run build:bin
./dist/hunk git
```

Install it into `~/.local/bin`:

```bash
bun run install:bin
hunk git
```

If you want a different install location, set `HUNK_INSTALL_DIR` before running the install script.

## Workflows

- `hunk git [range]`
- `hunk diff <left> <right>`
- `hunk patch [file|-]`
- `hunk difftool <left> <right> [path]`

## Interaction

- `1` split view
- `2` stacked view
- `0` auto layout
- `t` cycle themes
- `a` toggle the agent panel
- `[` / `]` move between hunks
- `/` focus the file filter
- `tab` cycle focus regions
- `q` or `Esc` quit

## Agent sidecar format

Use `--agent-context <file>` to load a JSON sidecar and show agent rationale next to the diff.

The order of `files` in the sidecar is significant. Hunk uses that order for the sidebar and main review stream so an agent can tell a story instead of relying on raw patch order.

```json
{
  "version": 1,
  "summary": "High-level change summary from the agent.",
  "files": [
    {
      "path": "src/core/loaders.ts",
      "summary": "Normalizes git and patch inputs into one changeset model.",
      "annotations": [
        {
          "newRange": [120, 156],
          "summary": "Adds the patch loader entrypoint.",
          "rationale": "Keeps all diff sources flowing through one normalized shape.",
          "tags": ["parser", "architecture"],
          "confidence": "high"
        }
      ]
    },
    {
      "path": "src/ui/App.tsx",
      "summary": "Presents the new workflow after the loader changes.",
      "annotations": [
        {
          "newRange": [90, 136],
          "summary": "Uses the normalized model in the review shell.",
          "rationale": "The reader should inspect this after understanding the loader changes.",
          "tags": ["ui"],
          "confidence": "medium"
        }
      ]
    }
  ]
}
```

Files omitted from the sidecar keep their original diff order and appear after the explicitly ordered files.

## Codex workflow

For Codex-driven changes, keep a transient sidecar at `.hunk/latest.json` and load it during review:

```bash
hunk git --agent-context .hunk/latest.json
```

Suggested pattern:

- Codex makes code changes.
- Codex refreshes `.hunk/latest.json` with a concise changeset summary, file summaries, and hunk-level rationale.
- You open `hunk` against the working tree, staged diff, or a commit range with that sidecar.

Keep the sidecar concise. It should explain why a hunk exists, what risk to review, and how the files fit together. It should not narrate obvious syntax edits line by line.

## Comparison

### Feature comparison

| Capability | hunk | difftastic | delta | diff |
| --- | --- | --- | --- | --- |
| Dedicated interactive review UI | ✅ | ❌ | ❌ | ❌ |
| Multi-file review stream with navigation sidebar | ✅ | ❌ | ❌ | ❌ |
| Agent / AI rationale sidecar | ✅ | ❌ | ❌ | ❌ |
| Split diffs | ✅ | ✅ | ✅ | ✅ |
| Stacked diffs | ✅ | ✅ | ✅ | ✅ |
| Auto responsive layouts | ✅ | ❌ | ❌ | ❌ |
| Themes | ✅ | ❌ | ✅ | ❌ |
| Syntax highlighting | ✅ | ✅ | ✅ | ❌ |
| Syntax-aware / structural diffing | ❌ | ✅ | ❌ | ❌ |
| Mouse support inside the diff viewer | ✅ | ❌ | ❌ | ❌ |
| Runtime toggles for wrapping / line numbers / hunk metadata | ✅ | ❌ | ❌ | ❌ |
| Pager-compatible mode | ✅ | ✅ | ✅ | ✅ |

### Local timing snapshot

These numbers are **not a universal benchmark**. They are a quick local comparison from one Linux machine using tmux panes, measuring **time until a changed marker first became visible** on the same 120-line TypeScript file pair.

Commands used:

- `hunk diff before.ts after.ts`
- `difft --display side-by-side before.ts after.ts`
- `delta --paging=never before.ts after.ts`
- `diff -u before.ts after.ts`

| Tool | Avg first-visible changed output |
| --- | ---: |
| `diff` | ~37 ms |
| `delta --paging=never` | ~35 ms |
| `hunk diff` | ~219 ms |
| `difft --display side-by-side` | ~266 ms |

Interpretation:

- `diff` and `delta` are fastest here because they emit plain diff text and exit.
- `hunk` pays extra startup cost for an interactive terminal UI, syntax highlighting, navigation state, and optional agent context.
- `difftastic` pays extra cost for syntax-aware / structural diffing.
- For larger review sessions, Hunk is optimized for **navigating and understanding** a changeset, not just dumping the quickest possible patch text.

## Git integration

Use Hunk as the default Git pager:

```bash
git config --global core.pager 'hunk patch -'
```

Or scope it just to `git diff` and `git show`:

```bash
git config --global pager.diff 'hunk patch -'
git config --global pager.show 'hunk patch -'
```

When Hunk reads a patch from stdin, it automatically switches to pager-style chrome, strips Git's color escape sequences before parsing, and binds keyboard input to the controlling terminal so it works correctly as a Git pager.

Then:

```bash
git diff
git show HEAD
```

If you want Git to launch Hunk as a difftool for file-to-file comparisons:

```bash
git config --global diff.tool hunk
git config --global difftool.hunk.cmd 'hunk difftool "$LOCAL" "$REMOTE" "$MERGED"'
```
