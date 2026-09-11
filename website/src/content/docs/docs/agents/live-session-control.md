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
```

Hunk numbers are 1-based. Absolute navigation needs a file and exactly one hunk, old-line, or new-line target.

## Reload the review

Always place `--` before the nested Hunk command:

```bash
hunk session reload --repo . -- diff
hunk session reload --repo . -- show HEAD~1 -- README.md
```

Advanced reloads can target the live window by `--session-path` and load from a separate `--source` directory. Prefer `--repo` until those roles genuinely need to differ.

## Diagnose local access

If a visible Hunk window does not appear in `session list`, an agent sandbox may block loopback access. Hunk's daemon is intentionally local-only; retry with the agent's network/sandbox permission rather than exposing it remotely. `hunk daemon serve` is available for manual startup or daemon debugging.

## Daemon build mismatches

After a Hunk upgrade, a daemon from the previous build keeps running while any older window holds it open. A window from the new build shows a status-bar notice naming both builds, and every `hunk session` command fails with a `daemon-build-mismatch` error (in-band under `--json`) that names both builds, counts the attached windows, and recommends `restart-daemon` or `use-newer-hunk`. Run `hunk daemon status` to see the daemon's build and attached windows, and `hunk daemon restart` to replace it with one from this build after confirming; windows that could not attach register on their own afterwards, while windows from the old build must be relaunched. Agents should report the mismatch and ask before restarting.
