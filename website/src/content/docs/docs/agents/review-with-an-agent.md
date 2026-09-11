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

Install the bundled review skill into your agent once:

```bash
hunk skill install --agent claude
```

`--agent` accepts `claude`, `codex`, `opencode`, `cursor`, `amp`, `copilot`, and `agents` for any tool that reads the shared `.agents/skills` convention. Repeat it to install into several agents at once, or add `--project` to write the skill into the current repository instead of your home directory.

The installed file is a short pointer, not a copy. It keeps the skill's name and description so the agent knows when to use it, and loads the instructions with `hunk skill show`, so upgrading Hunk never leaves a stale skill behind. See [Hunk review skill](/docs/agents/review-skill/) for the details.

Then ask the agent to review the session. Without an installed skill, a portable prompt is:

```text
Run `hunk skill show` and follow that skill to review the live Hunk session.
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

![A Hunk review with agent rationale rendered directly beside the annotated diff hunk](/docs/images/agent-comments.webp)

Agent notes remain spatially attached to the code they explain. Use `{` and `}` to move between annotated hunks while keeping the full changeset visible.

## Give the agent the docs

These docs are published as plain Markdown so an agent can read them without scraping HTML:

- [/llms.txt](https://hunk.dev/llms.txt) — index of every page, for pulling only what is needed.
- [/llms-small.txt](https://hunk.dev/llms-small.txt) — compact corpus for tight context budgets.
- [/llms-full.txt](https://hunk.dev/llms-full.txt) — the complete docs in one file, around 130KB.

Any docs page URL also returns its Markdown source with `.md` appended, so `https://hunk.dev/docs/reference/cli.md` is the CLI reference as the agent should read it.

## Keep control

The agent can guide the visible selection and add agent-authored notes, but you remain in the review stream and can navigate normally. Ask it to summarize when finished, then use `{` and `}` to walk annotated hunks.
