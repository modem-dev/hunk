---
title: Hunk review skill
description: Load the versioned machine guidance that teaches coding agents Hunk's live review protocol.
---

Hunk ships a generated `hunk-review` skill with every installation. It is the authoritative machine-facing workflow for session selection, efficient review inspection, navigation, reloads, and comments.

## Install it into your agent

```bash
npx skills add modem-dev/hunk -g --skill hunk-review
npx skills add modem-dev/hunk --skill hunk-review -a claude-code -a codex
```

The [skills CLI](https://github.com/vercel-labs/skills) handles agent detection and installation locations. Installation requires Node/npm and network access. Use `-g` for user-wide installation; omit it to install into the current project. Use `-a` to target specific agents, or follow the interactive agent selection.

The installed file is deliberately light. It carries the skill's `name` and `description` so the agent knows when to use it, and its body tells the agent to run:

```bash
hunk skill show
```

That prints the full skill shipped with the installed Hunk version, so the agent always sees instructions that match the CLI on the machine, and upgrading Hunk never requires reinstalling the skill.

## Use without installing a skill

Without Node/npm, or if you prefer not to install a skill, tell your agent: “Run `hunk skill show` and follow its instructions to review the live Hunk session.”

You can also locate or read either bundled skill directly:

```bash
hunk skill show   # print the full skill
hunk skill path   # print its path, for agents that load or symlink files
```

For agents that need a stable web-readable URL, use the [generated Hunk review skill](/docs/hunk-review-skill.md). The published artifact and installed skill are rendered by the same function; neither is a handwritten copy.

## Why it is generated

The checked-in `packages/hunk/skills/hunk-review/SKILL.md` is rendered from typed command metadata and agent error definitions in Hunk's source. Parser help, examples, constraints, and common remedies therefore share ownership instead of drifting as separate handwritten copies.

Do not edit the generated skill directly. Contributors change `packages/hunk/src/hunk-review/skillDocument.ts`, `packages/hunk/src/session/agent/surface.ts`, or `packages/hunk/src/session/agent/errors.ts`, then run:

```bash
bun run generate:skill
```

## Use it safely

The skill instructs agents to avoid launching interactive commands such as `hunk diff` themselves. The user owns the TUI; the agent talks to an already-live review through `hunk session *`.

For the human workflow around that surface, start with [Review with an agent](/docs/agents/review-with-an-agent/).
