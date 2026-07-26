---
title: Troubleshooting
description: Diagnose missing input, session access, terminal behavior, and configuration problems.
---

## Hunk shows no changes

Confirm the VCS and input first:

```bash
git status --short
hunk diff --help
```

A Git working-tree review includes untracked files by default. Pager input does not, because Git decides what enters the pipe. Check `vcs` when a directory contains markers for more than one backend.

## A live session is not found

Keep the Hunk TUI open, then run:

```bash
hunk session list
hunk session get --repo .
```

Use the repository root that the live review loaded. If an agent sandbox blocks loopback networking, grant local network access and retry. Do not expose the local daemon publicly. If the daemon itself prevents startup, set `HUNK_MCP_DISABLE=1` to run the TUI without session registration, then report the failure.

## Watch mode is rejected

`--watch` needs file- or VCS-backed input Hunk can reopen. It cannot replay stdin patches or `--agent-context -`. Save the input to a file or use `hunk diff` / `hunk show` directly.

## Theme detection looks wrong

Some terminals do not answer background-color queries. `theme = "auto"` then falls back to `github-dark-default`; choose a theme explicitly if needed. Disable transparency if terminal compositing makes contrast unpredictable.

## Layout or text is hard to read

Try stack mode and wrapping in a narrow terminal:

```bash
hunk diff --mode stack --wrap
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
