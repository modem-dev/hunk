---
title: Review with an agent
description: Let a coding agent inspect and guide a live Hunk review without giving up the human review UI.
---

The Hunk window stays with you. Your agent uses non-interactive `hunk session` commands from another terminal to inspect the same review, navigate it, and leave inline notes.

## Start the review

```bash
hunk diff
```

Keep that window open. Normal Hunk sessions register with a local loopback daemon so the session CLI can find them.

## Give the agent the skill

In the agent's shell, locate the skill bundled with the installed Hunk version:

```bash
hunk skill path
```

Ask the agent to load that file and use it for the review. A portable prompt is:

```text
Load the Hunk skill and use it for this review. Run `hunk skill path` to get the skill path.
```

The skill tells agents not to launch the interactive TUI themselves. It teaches them to use the session surface instead.

## What the agent does

A typical agent flow is:

```bash
hunk session list
hunk session get --repo .
hunk session review --repo . --json
hunk session navigate --repo . --file src/App.tsx --hunk 2
hunk session comment add --repo . --file src/App.tsx --new-line 42 --summary "Check this boundary"
```

`review --json` exposes structure without forcing the full patch into agent context. The agent should request `--include-patch` only when it actually needs raw unified diff text.

## Keep control

The agent can guide the visible selection and add agent-authored notes, but you remain in the review stream and can navigate normally. Ask it to summarize when finished, then use `{` and `}` to walk annotated hunks.
