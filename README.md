# hunk

Hunk is a review-first terminal diff viewer for agent-authored changesets, built on [OpenTUI](https://github.com/anomalyco/opentui) and [Pierre diffs](https://www.npmjs.com/package/@pierre/diffs).

[![CI status](https://img.shields.io/github/actions/workflow/status/modem-dev/hunk/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/modem-dev/hunk/actions/workflows/ci.yml?branch=main)
[![Latest release](https://img.shields.io/github/v/release/modem-dev/hunk?style=for-the-badge)](https://github.com/modem-dev/hunk/releases)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

- multi-file review stream with sidebar navigation
- inline AI and agent annotations beside the code
- split, stack, and responsive auto layouts
- watch mode for auto-reloading file and Git-backed reviews
- keyboard, mouse, pager, and Git difftool support

<table>
 <tr>
   <td width="60%" align="center">
     <img width="794" alt="image" src="https://github.com/user-attachments/assets/f6ffd9c4-67f5-483c-88f1-cbe88c19f52f" />
     <br />
     <sub>Split view with sidebar and inline AI notes</sub>
   </td>
   <td width="40%" align="center">
     <img width="508" height="920" alt="image" src="https://github.com/user-attachments/assets/44c542a2-0a09-41cd-b264-fbd942e92f06" />
     <br />
     <sub>Stacked view and mouse-selectable menus</sub>
   </td>
 </tr>
</table>

## Install

```bash
npm i -g hunkdiff
```

To use the reusable OpenTUI component in your own app:

```bash
npm i hunkdiff
```

Requirements:

- Node.js 18+
- macOS or Linux
- Git recommended for most workflows

## Quick start

```bash
hunk           # show help
hunk --version # print the installed version
```

### Working with Git

Hunk mirrors Git's diff-style commands, but opens the changeset in a review UI instead of plain text.

```bash
hunk diff                      # review current repo changes, including untracked files
hunk diff --watch              # auto-reload as the working tree changes
hunk show                      # review the latest commit
hunk show HEAD~1               # review an earlier commit
```

### Working with raw files and patches

```bash
hunk diff before.ts after.ts                # compare two files directly
hunk diff before.ts after.ts --watch        # auto-reload when either file changes
git diff --no-color | hunk patch -          # review a patch from stdin
```

### Working with agents

Load the [`skills/hunk-review/SKILL.md`](skills/hunk-review/SKILL.md) skill in your coding agent (e.g. Claude, Codex, Opencode, Pi).

Open Hunk in another window, then ask your agent to leave comments.

## Feature comparison

| Capability                         | [hunk](https://github.com/modem-dev/hunk) | [lumen](https://github.com/jnsahaj/lumen) | [difftastic](https://github.com/Wilfred/difftastic) | [delta](https://github.com/dandavison/delta) | [diff-so-fancy](https://github.com/so-fancy/diff-so-fancy) | [diff](https://www.gnu.org/software/diffutils/) |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------- | --------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| Review-first interactive UI        | ✅                                        | ✅                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Multi-file review stream + sidebar | ✅                                        | ✅                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Inline agent / AI annotations      | ✅                                        | ❌                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Responsive auto split/stack layout | ✅                                        | ❌                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Mouse support inside the viewer    | ✅                                        | ✅                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Runtime view toggles               | ✅                                        | ✅                                        | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Syntax highlighting                | ✅                                        | ✅                                        | ✅                                                  | ✅                                           | ❌                                                         | ❌                                              |
| Structural diffing                 | ❌                                        | ❌                                        | ✅                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Pager-compatible mode              | ✅                                        | ❌                                        | ✅                                                  | ✅                                           | ✅                                                         | ✅                                              |

Hunk is optimized for reviewing a full changeset interactively.

## Advanced

### OpenTUI component

Hunk also publishes a reusable OpenTUI React diff component powered by the same terminal renderer that the app uses.

Runnable source examples live in [`examples/7-opentui-component`](examples/7-opentui-component/README.md).

Import it from `hunkdiff/opentui`:

```tsx
import { HunkDiffView, parseDiffFromFile } from "hunkdiff/opentui";

const metadata = parseDiffFromFile(
  {
    cacheKey: "before",
    contents: "export const value = 1;\n",
    name: "example.ts",
  },
  {
    cacheKey: "after",
    contents: "export const value = 2;\nexport const added = true;\n",
    name: "example.ts",
  },
  { context: 3 },
  true,
);

<HunkDiffView
  diff={{
    id: "example",
    metadata,
    language: "typescript",
    path: "example.ts",
  }}
  layout="split"
  width={88}
  theme="midnight"
/>;
```

Public API:

- `diff?: { id, metadata, language?, path?, patch? }`
- `layout?: "split" | "stack"`
- `width: number`
- `theme?: "graphite" | "midnight" | "paper" | "ember"`
- `showLineNumbers?: boolean`
- `showHunkHeaders?: boolean`
- `wrapLines?: boolean`
- `horizontalOffset?: number`
- `highlight?: boolean`
- `scrollable?: boolean`
- `selectedHunkIndex?: number`

The component re-exports `parseDiffFromFile`, `parsePatchFiles`, and `FileDiffMetadata` from `@pierre/diffs` so callers can build the `metadata` input without adding a second diff dependency.

### Config

You can persist preferences to a config file:

- `~/.config/hunk/config.toml`
- `.hunk/config.toml`

Example:

```toml
theme = "graphite"   # graphite, midnight, paper, ember
mode = "auto"        # auto, split, stack
exclude_untracked = false
line_numbers = true
wrap_lines = false
agent_notes = false
```

`exclude_untracked` affects working-tree `hunk diff` sessions only.

### Git integration

Set Hunk as your Git pager so `git diff` and `git show` open in Hunk automatically:

> [!NOTE]
> Untracked files are auto-included only for Hunk's own `hunk diff` working-tree loader. If you open `git diff` through `hunk pager`, Git still decides the patch contents, so untracked files will not appear there.

```bash
git config --global core.pager "hunk pager"
```

Or in your Git config:

```ini
[core]
    pager = hunk pager
```

If you want to keep Git's default pager and add opt-in aliases instead:

```bash
git config --global alias.hdiff "-c core.pager=\"hunk pager\" diff"
git config --global alias.hshow "-c core.pager=\"hunk pager\" show"
```

### Agent workflows

Hunk supports two agent workflows:

- steer a live Hunk window from another terminal with `hunk session ...` (recommended)
- load agent comments from a file with `--agent-context`

#### Steer a live Hunk window

Use the Hunk review skill: [`skills/hunk-review/SKILL.md`](skills/hunk-review/SKILL.md).

A good generic prompt is:

```text
> Load the Hunk skill and use it for this review
```

That skill teaches the agent how to inspect a live Hunk session, navigate it, reload it, and leave inline comments.

#### How remote control works

When a Hunk TUI starts, it registers with a local loopback daemon. `hunk session ...` talks to that daemon to find the right live window and control it.

Use it to:

- inspect the current review context
- export the loaded review structure for agent workflows
- optionally include raw patch text when an agent truly needs it
- jump to a file, hunk, or line
- reload the current window with a different `diff` or `show` command
- add, batch-apply, list, and remove inline comments

Most users only need `hunk session ...`. Use `hunk mcp serve` only for manual startup or debugging of the local daemon.

```bash
hunk session list
hunk session get --repo .
hunk session context --repo .
hunk session review --repo . --json
hunk session review --repo . --include-patch --json
hunk session navigate --repo . --file README.md --hunk 2
hunk session reload --repo . -- diff
hunk session reload --repo /path/to/worktree -- diff
hunk session reload --session-path /path/to/live-window --source /path/to/other-checkout -- diff
hunk session reload --repo . -- show HEAD~1 -- README.md
hunk session comment add --repo . --file README.md --new-line 103 --summary "Tighten this wording"
hunk session comment add --repo . --file README.md --new-line 103 --summary "Tighten this wording" --focus
printf '%s\n' '{"comments":[{"filePath":"README.md","newLine":103,"summary":"Tighten this wording"}]}' | hunk session comment apply --repo . --stdin
printf '%s\n' '{"comments":[{"filePath":"README.md","hunk":2,"summary":"Explain this hunk"}]}' | hunk session comment apply --repo . --stdin --focus
hunk session comment list --repo .
hunk session comment rm --repo . <comment-id>
hunk session comment clear --repo . --file README.md --yes
```

`hunk session review --json` returns file and hunk structure by default. Add `--include-patch` only when a caller truly needs raw unified diff text in the response.

`hunk session reload ... -- <hunk command>` swaps what a live session is showing without opening a new TUI window.
Pass `--focus` to jump the live session to the new note, or to the first note in a batch apply.

`hunk session comment apply` reads one stdin JSON object with a top-level `comments` array. Each item needs `filePath`, `summary`, and exactly one target such as `hunk`, `hunkNumber`, `oldLine`, or `newLine`.

- `--repo <path>` selects the live session by its current loaded repo root.
- `--source <path>` is reload-only: it changes where the nested `diff` / `show` command runs, but does not select the session.
- For normal worktree use, prefer targeting the worktree session directly with `hunk session reload --repo /path/to/worktree -- diff`.
- Use `--session-path` + `--source` only for advanced cases where you want to repoint an already-open live window to another checkout or path.

#### Load agent comments from a file

Use `--agent-context` to attach agent-written comments or rationale from a JSON sidecar file. For a compact real example, see [`examples/3-agent-review-demo/agent-context.json`](examples/3-agent-review-demo/agent-context.json).

```bash
hunk diff --agent-context notes.json
hunk patch change.patch --agent-context notes.json
```

## Examples

Ready-to-run demo diffs live in [`examples/`](examples/README.md).

Each example includes the exact command to run from the repository root.

## Contributing

For source setup, tests, packaging checks, and repo architecture, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
