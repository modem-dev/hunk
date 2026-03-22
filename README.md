# hunk

<p align="center">
  <a href="https://github.com/modem-dev/hunk/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/modem-dev/hunk/ci.yml?branch=main&style=for-the-badge&label=CI" alt="CI status"></a>
  <a href="https://github.com/modem-dev/hunk/releases"><img src="https://img.shields.io/github/v/release/modem-dev/hunk?style=for-the-badge" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

Hunk is a desktop-inspired terminal diff viewer for reviewing agent-authored changesets.

- full-screen multi-file review stream
- split, stacked, and responsive auto layouts
- keyboard and mouse navigation
- optional agent rationale beside annotated hunks
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

## Config

Hunk reads config from:

- `~/.config/hunk/config.toml`
- `.hunk/config.toml`

Example:

```toml
theme = "midnight" # midnight, graphite, paper, ember
mode = "auto"      # auto, split, stack
line_numbers = true
wrap_lines = false
agent_notes = false
```

## Advanced workflows

- `hunk diff --agent-context <file>` loads inline agent rationale from a JSON sidecar
- `hunk mcp serve` runs the local MCP daemon for agent-to-diff communication

## Performance notes

Hunk spends more startup time than plain diff output tools because it launches an interactive UI with syntax highlighting, navigation state, and optional agent context. In exchange, it is optimized for reviewing a full changeset instead of printing static diff text and exiting.

## Contributing

For source setup, tests, packaging checks, and repo architecture, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
