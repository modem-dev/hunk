---
title: Live session control
description: Inspect, target, navigate, and reload Hunk windows through the local session broker.
---

Each normal Hunk TUI registers with one loopback daemon. `hunk session ...` finds a registered window and sends it review actions.

## Find the session

```bash
hunk session list
hunk session get --repo .
hunk session context --repo .
```

Use `--repo <path>` for normal worktrees. Use an explicit session ID when multiple windows share a repository.

## Inspect without overloading context

```bash
hunk session review --repo . --json
```

This returns files and hunks. Add flags only when required:

```bash
hunk session review --repo . --include-notes --json
hunk session review --repo . --include-patch --json
```

## Navigate the visible window

```bash
hunk session navigate --repo . --file src/App.tsx --hunk 2
hunk session navigate --repo . --file src/App.tsx --new-line 372
hunk session navigate --repo . --next-comment
hunk session navigate --repo . --comment <comment-id>
```

Hunk numbers are 1-based. Absolute navigation needs a file and exactly one hunk, old-line, or new-line target. `--next-comment` and `--prev-comment` move between annotated hunks; `--comment` jumps to one note by the id that `comment list --json` returns.

## Reload the review

Always place `--` before the nested Hunk command:

```bash
hunk session reload --repo . -- diff
hunk session reload --repo . -- show HEAD~1 -- README.md
```

Advanced reloads can target the live window by `--session-path` and load from a separate `--source` directory. Prefer `--repo` until those roles genuinely need to differ.

## Security and access

The daemon listens on `127.0.0.1:47657` and refuses non-loopback addresses. Session commands authenticate with an owner-private credential that Hunk discovers automatically, so only your user account can control your windows; there are no credential flags to pass. The daemon starts with the first Hunk window and shuts down about a minute after the last one closes.

| Variable                         | Effect                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `HUNK_MCP_HOST`, `HUNK_MCP_PORT` | Move the daemon to another loopback host or port, for example to avoid a port conflict.    |
| `HUNK_MCP_DISABLE=1`             | Start the TUI without registering a session.                                               |
| `HUNK_MCP_UNSAFE_ALLOW_REMOTE=1` | Allow a non-loopback host. Anyone who can reach the port can attempt to connect; avoid it. |

If a visible Hunk window does not appear in `session list`, an agent sandbox may be blocking loopback access. Grant the agent local network access and retry; don't expose the daemon remotely. `hunk daemon serve` starts the daemon in the foreground for debugging.

## After upgrading Hunk

A daemon from the previous build keeps running while any older Hunk window is open. Until it is replaced:

- a window from the new build shows a status-bar notice naming both builds, and
- every `hunk session` command fails with a `daemon-build-mismatch` error (reported in-band under `--json`).

To fix it:

1. Run `hunk daemon status` to see the daemon's build and its attached windows.
2. Run `hunk daemon restart` and confirm. Windows from the new build reattach on their own.
3. Relaunch any windows from the old build. Their notes are lost.

Agents should report the mismatch and ask before restarting the daemon.
