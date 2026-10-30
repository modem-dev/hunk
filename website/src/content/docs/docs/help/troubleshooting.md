---
title: Troubleshooting
description: Diagnose missing input, session access, terminal behavior, and configuration problems.
---

## Hunk shows no changes

Confirm that your VCS sees changes:

```bash
git status --short
```

If it lists files but Hunk shows nothing, check which backend Hunk picked. In a checkout with markers for more than one VCS (for example a colocated jj and Git repository), Hunk prefers Jujutsu, then Sapling; set `vcs` in the repository's `.hunk/config.toml` to choose. A Git working-tree review includes untracked files by default. Pager input does not, because Git decides what enters the pipe.

## A live session is not found

Keep the Hunk TUI open, then run:

```bash
hunk session list
hunk session get --repo .
```

Use the repository root that the live review loaded. If an agent sandbox blocks loopback networking, grant local network access and retry. Do not expose the local daemon publicly. If the daemon itself prevents startup, set `HUNK_MCP_DISABLE=1` to run the TUI without session registration, then report the failure.

If every `hunk session` command fails with `daemon-build-mismatch` after an upgrade, an older daemon is still running; see [After upgrading Hunk](/docs/agents/live-session-control/#after-upgrading-hunk). If another program holds port 47657, set `HUNK_MCP_PORT` to a free port in the environment of both Hunk and your agent.

## Watch mode is rejected

`--watch` needs an interactive terminal and file- or VCS-backed input Hunk can reopen. It cannot run when Hunk's output is piped, and it cannot replay stdin patches or `--agent-context -`. Save the input to a file or use `hunk diff` / `hunk show` directly.

If `hunk pager` or `hunk patch -` fails with this error even though you didn't pass `--watch`, your config has a top-level `watch = true`. Move it into a command table such as `[vcs]`; see [Watch mode](/docs/workflows/watch-mode/#turn-it-on-by-default).

## Theme detection looks wrong

Some terminals do not answer color queries. The opt-in `terminal` theme then falls back to a standard xterm-style palette and `theme = "auto"` falls back to `github-dark-default`; choose a theme explicitly if needed. If you turned on `transparent_background`, turn it off (`--no-transparent-bg`) when terminal compositing makes contrast unpredictable.

## Layout or text is hard to read

Try unified mode and wrapping in a narrow terminal:

```bash
hunk diff --mode unified --wrap
```

Press `?` for shortcuts, `t` for themes, and `l` for line numbers. See [terminal compatibility](/docs/help/compatibility/) for mouse, color, and clipboard limits.

## Useful environment variables

| Variable           | Purpose                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `HUNK_DEBUG=1`     | Print stack traces for failures; include the output in bug reports.                                                          |
| `HUNK_MCP_DISABLE` | Set to `1` to start the TUI without registering a live session (escape hatch for daemon trouble).                            |
| `HUNK_BIN_PATH`    | Override which binary the npm launcher runs.                                                                                 |
| `HUNK_TEXT_PAGER`  | Choose the plain-text pager used for non-diff output; see [Git pager and difftool](/docs/workflows/git-pager-and-difftool/). |

## Get command-specific help

```bash
hunk --help
hunk diff --help
hunk session --help
```

When reporting a bug, include Hunk version, OS, terminal name/version, shell, command shape, `HUNK_DEBUG=1` output, and a minimal safe patch when possible.
