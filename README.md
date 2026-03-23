<img width="384" height="384" alt="image" src="https://github.com/user-attachments/assets/85c5ba93-9de1-4757-87ae-4520b8fd659f" />

# hunk - TUI diff tool that's AI-friendly

[![CI status](https://img.shields.io/github/actions/workflow/status/modem-dev/hunk/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/modem-dev/hunk/actions/workflows/ci.yml?branch=main)
[![Latest release](https://img.shields.io/github/v/release/modem-dev/hunk?style=for-the-badge)](https://github.com/modem-dev/hunk/releases)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

Hunk is a desktop-inspired terminal diff viewer for reviewing agent-authored changesets.

- AI annotations
- full-screen multi-file review stream
- keyboard & mouse support
- split, stacked, and responsive auto layouts
- Git pager and difftool integration

## Install

```bash
npm i -g hunkdiff
```

Requirements:

- Node.js 18+
- Currently supported on macOS and Linux
- Git is recommended for most workflows

## Usage

### Basics

```bash
hunk           # show help
hunk --version # get version
```

### Working with Git

```bash
hunk diff         # review current repo changes
hunk diff --staged
hunk show         # review the latest commit
hunk show HEAD~1  # review an earlier commit
```

### Working with raw files/patches

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

You can set Hunk as your Git pager so `git diff` and `git show` open in Hunk automatically.

From the terminal:

```bash
git config --global core.pager "hunk pager"
```

Or in your Git config:

```ini
[core]
    pager = hunk pager
```

If you’d rather keep Git’s default `diff` and `show` behavior, you can add optional aliases instead:

```bash
git config --global alias.hdiff "-c core.pager=\"hunk pager\" diff"
git config --global alias.hshow "-c core.pager=\"hunk pager\" show"
```

## Examples

Ready-to-run demo diffs live in [`examples/`](examples/README.md).

Each example includes the exact command to run from the repository root.

## Agent skill

Hunk ships a bundled agent skill named `hunk-review` in `skills/hunk-review/SKILL.md`.

It is written as a self-contained skill for skill-aware coding agents. The skill teaches an agent to:

- briefly explain what Hunk is
- prefer `hunk session ...` when a live Hunk review window already exists
- inspect current review focus before navigating blindly
- use `hunk session reload` to swap what an existing live session is showing
- leave concise inline review comments tied to real diff lines

If your coding agent supports packaged or repo-local skills, point it at this repository or copy the `skills/hunk-review/` directory into that agent's skill search path.

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

## Advanced workflows

- `hunk diff --agent-context <file>` loads inline agent rationale from a JSON sidecar
- `hunk mcp serve` runs the local Hunk session daemon and websocket broker for manual startup or debugging
  - normal Hunk sessions auto-start/register with it by default
  - coding agents should usually interact through `hunk session ...`, not by managing the daemon directly
  - Hunk keeps the daemon loopback-only by default
  - if you intentionally need remote access, set `HUNK_MCP_UNSAFE_ALLOW_REMOTE=1` and choose a non-loopback `HUNK_MCP_HOST`

### Live session control CLI

`hunk session ...` is the user-facing and agent-facing interface to Hunk's local live review session daemon.

Use explicit session targeting with either a live `<session-id>` or `--repo <path>` when exactly one live session matches that repo root.

```bash
hunk session list
hunk session context --repo .
hunk session navigate --repo . --file README.md --hunk 2
hunk session reload --repo . -- diff
hunk session reload --repo . -- show HEAD~1 -- README.md
hunk session comment add --repo . --file README.md --new-line 103 --summary "Frame this as MCP-first"
hunk session comment list --repo .
hunk session comment rm --repo . <comment-id>
hunk session comment clear --repo . --file README.md --yes
```

`hunk session reload ... -- <hunk command>` swaps the live session to a new `diff`, `show`, or other reviewable Hunk input without opening a new TUI window.

The session CLI can inspect, navigate, annotate, and reload a live session, but it does not edit `.hunk/latest.json`.

## Performance notes

Hunk spends more startup time than plain diff output tools because it launches an interactive UI with syntax highlighting, navigation state, and optional agent context. In exchange, it is optimized for reviewing a full changeset instead of printing static diff text and exiting.

## Contributing

For source setup, tests, packaging checks, and repo architecture, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
