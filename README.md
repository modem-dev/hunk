# hunk

<p align="center">
  <a href="https://github.com/modem-dev/hunk/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/modem-dev/hunk/ci.yml?branch=main&style=for-the-badge&label=CI" alt="CI status"></a>
  <a href="https://github.com/modem-dev/hunk/releases"><img src="https://img.shields.io/github/v/release/modem-dev/hunk?style=for-the-badge" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

Hunk is a terminal diff viewer for reviewing agent-authored changesets with a desktop-style UI.

- full-screen multi-file review stream
- split, stacked, and responsive auto layouts
- keyboard and mouse navigation
- optional agent rationale beside annotated hunks
- Git pager and difftool integration

## Install

```bash
npm i -g hunkdiff
```

## Requirements

- Node.js 18+
- Git for `hunk diff`, `hunk show`, `hunk stash show`, and pager integration

## Quick start

Review your current working tree:

```bash
hunk diff
```

Review staged changes:

```bash
hunk diff --staged
```

Review a commit:

```bash
hunk show HEAD~1
```

Compare two files directly:

```bash
hunk diff before.ts after.ts
```

Open a patch from stdin:

```bash
git diff --no-color | hunk patch -
```

## Feature comparison

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

## Benchmarks

Quick local timing snapshot from one Linux machine on the same 120-line TypeScript file pair. Metric: time until a changed marker first became visible.

| Tool | Avg first-visible changed output |
| --- | ---: |
| `diff` | ~37 ms |
| `delta --paging=never` | ~35 ms |
| `hunk diff` | ~219 ms |
| `difft --display side-by-side` | ~266 ms |

Takeaway:

- `diff` and `delta` are fastest here because they print plain diff text and exit.
- `hunk` spends more startup time on an interactive UI, syntax highlighting, navigation state, and optional agent context.
- `difftastic` spends more startup time on structural diffing.

## Common workflows

- `hunk` — print CLI help
- `hunk diff` — review working tree changes
- `hunk diff --staged` / `hunk diff --cached` — review staged changes
- `hunk diff <ref>` — review changes versus a branch, tag, or commit-ish
- `hunk diff <ref1>..<ref2>` / `hunk diff <ref1>...<ref2>` — review Git ranges
- `hunk diff -- <pathspec...>` — limit review to selected paths
- `hunk show [ref]` — review the last commit or a specific ref
- `hunk stash show [ref]` — review a stash entry
- `hunk patch [file|-]` — review a patch file or stdin
- `hunk pager` — act as a Git pager wrapper, opening Hunk for diff-like stdin and falling back to plain text paging otherwise
- `hunk difftool <left> <right> [path]` — integrate with Git difftool
- `hunk mcp serve` — run the local MCP daemon for agent-to-diff communication

## MCP daemon (experimental)

Hunk can run a local MCP daemon that brokers commands to live Hunk TUI sessions.

```bash
hunk mcp serve
```

Current v1 scope:

- local loopback daemon only
- live session discovery via `list_sessions` / `get_session`
- inline diff comments via `comment`
- Linux-first implementation, designed to stay portable to macOS later

Environment variables:

- `HUNK_MCP_HOST` — bind host for the daemon and session clients, default `127.0.0.1`
- `HUNK_MCP_PORT` — bind port for the daemon and session clients, default `47657`
- `HUNK_MCP_DISABLE=1` — disable background session registration for one Hunk process

## Interaction

- `1` split view
- `2` stacked view
- `0` auto layout
- `t` cycle themes
- `a` toggle the agent panel
- `l` toggle line numbers
- `w` toggle line wrapping
- `m` toggle hunk metadata
- `[` / `]` move between hunks
- `space` / `b` page forward and backward
- `/` focus the file filter
- `tab` cycle focus regions
- `q` or `Esc` quit

## Git integration

Use Hunk directly for full-screen review:

```bash
hunk diff
hunk diff --staged
hunk diff main...feature
hunk show
hunk stash show
```

Use Hunk as a pager for `git diff` and `git show`:

```bash
git config --global core.pager 'hunk patch -'
```

Or scope it just to diff/show:

```bash
git config --global pager.diff 'hunk patch -'
git config --global pager.show 'hunk patch -'
```

Use Hunk as a Git difftool:

```bash
git config --global diff.tool hunk
git config --global difftool.hunk.cmd 'hunk difftool "$LOCAL" "$REMOTE" "$MERGED"'
```

## Configuration

Hunk reads layered TOML config with this precedence:

1. built-in defaults
2. global config: `$XDG_CONFIG_HOME/hunk/config.toml` or `~/.config/hunk/config.toml`
3. repo-local config: `.hunk/config.toml`
4. command-specific sections like `[diff]`, `[show]`, `[stash-show]`, `[patch]`, `[difftool]`
5. `[pager]` when Hunk is running in pager mode
6. explicit CLI flags

Example:

```toml
theme = "midnight"
mode = "auto"
line_numbers = true
wrap_lines = false
hunk_headers = true
agent_notes = false

[pager]
mode = "stack"
line_numbers = false

[diff]
mode = "split"
```

Supported one-off CLI overrides:

- `--mode <auto|split|stack>`
- `--theme <theme>`
- `--line-numbers` / `--no-line-numbers`
- `--wrap` / `--no-wrap`
- `--hunk-headers` / `--no-hunk-headers`
- `--agent-notes` / `--no-agent-notes`

## Agent context sidecar

Use `--agent-context <file>` to load a JSON sidecar and show agent rationale next to the diff.

The order of `files` in the sidecar is significant. Hunk uses that order for the sidebar and the main review stream so an agent can present a review narrative instead of raw patch order.

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
    }
  ]
}
```

For local agent-driven review, keep a transient sidecar at `.hunk/latest.json` and load it with:

```bash
hunk diff --agent-context .hunk/latest.json
```

## Development

Install dependencies:

```bash
bun install
```

Validate a change:

```bash
bun run typecheck
bun test
bun run test:tty-smoke
```

Build the npm runtime bundle used for publishing:

```bash
bun run build:npm
bun run check:pack
```

Stage the prebuilt npm packages for the current host and smoke test the install path without Bun on `PATH`:

```bash
bun run build:prebuilt:npm
bun run check:prebuilt-pack
bun run smoke:prebuilt-install
```

Prepare the multi-platform release directories from downloaded build artifacts and dry-run the publish order:

```bash
bun run build:prebuilt:artifact
bun run stage:prebuilt:release
bun run check:prebuilt-pack
bun run publish:prebuilt:npm -- --dry-run
```

The automated tag/manual release workflow lives in `.github/workflows/release-prebuilt-npm.yml`.

## License

[MIT](LICENSE)
