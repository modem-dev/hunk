<img width="384" height="384" alt="image" src="https://github.com/user-attachments/assets/85c5ba93-9de1-4757-87ae-4520b8fd659f" />

# hunk

Hunk is a review-first terminal diff viewer for agent-authored changesets.

[![CI status](https://img.shields.io/github/actions/workflow/status/modem-dev/hunk/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/modem-dev/hunk/actions/workflows/ci.yml?branch=main)
[![Latest release](https://img.shields.io/github/v/release/modem-dev/hunk?style=for-the-badge)](https://github.com/modem-dev/hunk/releases)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

- multi-file review stream with sidebar navigation
- inline AI and agent annotations beside the code
- split, stack, and responsive auto layouts
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
     <sub>Stacked view and mouse-selectable menus
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

hunk diff         # review current repo changes
hunk diff --staged
hunk show         # review the latest commit
hunk show HEAD~1  # review an earlier commit
```

Open raw files or patches directly:

```bash
hunk diff before.ts after.ts        # compare two files directly
git diff --no-color | hunk patch -  # review a patch from stdin
```

## Feature comparison

| Capability                                                  | hunk | difftastic | delta | diff |
| ----------------------------------------------------------- | ---- | ---------- | ----- | ---- |
| Dedicated interactive review UI                             | ✅   | ❌         | ❌    | ❌   |
| Multi-file review stream with navigation sidebar            | ✅   | ❌         | ❌    | ❌   |
| Agent / AI rationale sidecar                                | ✅   | ❌         | ❌    | ❌   |
| Split diffs                                                 | ✅   | ✅         | ✅    | ✅   |
| Stacked diffs                                               | ✅   | ✅         | ✅    | ✅   |
| Auto responsive layouts                                     | ✅   | ❌         | ❌    | ❌   |
| Themes                                                      | ✅   | ❌         | ✅    | ❌   |
| Syntax highlighting                                         | ✅   | ✅         | ✅    | ❌   |
| Syntax-aware / structural diffing                           | ❌   | ✅         | ❌    | ❌   |
| Mouse support inside the diff viewer                        | ✅   | ❌         | ❌    | ❌   |
| Runtime toggles for wrapping / line numbers / hunk metadata | ✅   | ❌         | ❌    | ❌   |
| Pager-compatible mode                                       | ✅   | ✅         | ✅    | ✅   |

## Git integration

Set Hunk as your Git pager so `git diff` and `git show` open in Hunk automatically:

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

## Examples

Ready-to-run demo diffs live in [`examples/`](examples/README.md).

Each example includes the exact command to run from the repository root.

## Config

Hunk reads config from:

- `~/.config/hunk/config.toml`
- `.hunk/config.toml`

Example:

```toml
theme = "graphite" # graphite, midnight, paper, ember
mode = "auto"      # auto, split, stack
line_numbers = true
wrap_lines = false
agent_notes = false
```

## Live sessions and agent workflows

Hunk can load inline rationale from a sidecar and lets you steer a live review window from another terminal or agent process.

- `hunk diff --agent-context <file>` or `hunk patch --agent-context <file>` shows inline agent rationale beside the diff
- `hunk session ...` inspects, navigates, reloads, and annotates a running Hunk session
- `skills/hunk-review/SKILL.md` helps coding agents steer a live Hunk review and write inline Hunk annotations

Normal Hunk sessions start and register with the local loopback session daemon automatically. In most cases, use `hunk session ...` and ignore `hunk mcp serve`.

```bash
hunk session list
hunk session context --repo .
hunk session navigate --repo . --file README.md --hunk 2
hunk session reload --repo . -- diff
hunk session reload --repo . -- show HEAD~1 -- README.md
hunk session comment add --repo . --file README.md --new-line 103 --summary "Tighten this wording"
hunk session comment list --repo .
hunk session comment rm --repo . <comment-id>
hunk session comment clear --repo . --file README.md --yes
```

`hunk session reload ... -- <hunk command>` swaps what a live session is showing without opening a new TUI window.

Use `hunk mcp serve` only for manual startup or debugging of the local session daemon.

## Contributing

For source setup, tests, packaging checks, and repo architecture, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
