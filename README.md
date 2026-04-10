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

1. Open Hunk in another terminal with `hunk diff` or `hunk show`.
2. Load the Hunk review skill: [`skills/hunk-review/SKILL.md`](skills/hunk-review/SKILL.md).
3. Ask your agent to use the skill against the live Hunk session.

A good generic prompt is:

```text
Load the Hunk skill and use it for this review.
```

> [!NOTE]
> `hunk skill path` lands in Hunk 0.10.0. Until that release is out, load the skill from the repo path above.

For the full live-session and `--agent-context` workflow guide, see [docs/agent-workflows.md](docs/agent-workflows.md).

## Feature comparison

| Capability                         | [hunk](https://github.com/modem-dev/hunk) | [lumen](https://github.com/jnsahaj/lumen) | [diffnav](https://github.com/dlvhdr/diffnav) | [difftastic](https://github.com/Wilfred/difftastic) | [delta](https://github.com/dandavison/delta) | [diff-so-fancy](https://github.com/so-fancy/diff-so-fancy) | [diff](https://www.gnu.org/software/diffutils/) |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------- | -------------------------------------------- | --------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| Review-first interactive UI        | ✅                                        | ✅                                        | ✅                                           | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Multi-file review stream + sidebar | ✅                                        | ✅                                        | ✅                                           | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Inline agent / AI annotations      | ✅                                        | ❌                                        | ❌                                           | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Responsive auto split/stack layout | ✅                                        | ❌                                        | ❌                                           | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Mouse support inside the viewer    | ✅                                        | ✅                                        | ✅                                           | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Runtime view toggles               | ✅                                        | ✅                                        | ✅                                           | ❌                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Syntax highlighting                | ✅                                        | ✅                                        | ✅                                           | ✅                                                  | ✅                                           | ❌                                                         | ❌                                              |
| Structural diffing                 | ❌                                        | ❌                                        | ❌                                           | ✅                                                  | ❌                                           | ❌                                                         | ❌                                              |
| Pager-compatible mode              | ✅                                        | ❌                                        | ✅                                           | ✅                                                  | ✅                                           | ✅                                                         | ✅                                              |

Hunk is optimized for reviewing a full changeset interactively.

## Advanced

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

### OpenTUI component

Hunk also publishes `HunkDiffView` from `hunkdiff/opentui` for embedding the same diff renderer in your own OpenTUI app.

See [docs/opentui-component.md](docs/opentui-component.md) for install, API, and runnable examples.

## Examples

Ready-to-run demo diffs live in [`examples/`](examples/README.md).

Each example includes the exact command to run from the repository root.

## Contributing

For source setup, tests, packaging checks, and repo architecture, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
