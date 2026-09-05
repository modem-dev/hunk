---
title: Hunk review skill
description: Load the versioned machine guidance that teaches coding agents Hunk's live review protocol.
---

Hunk ships a generated `hunk-review` skill with every installation. It is the authoritative machine-facing workflow for session selection, efficient review inspection, navigation, reloads, and comments.

## Locate the installed skill

```bash
hunk skill path
```

Load or symlink the returned file according to your coding agent's skill mechanism. Resolve the path again after upgrades so the guidance stays aligned with the installed CLI.

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
