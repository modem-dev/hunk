---
title: Hunk review skill
description: Load the versioned machine guidance that teaches coding agents Hunk's live review protocol.
---

Hunk ships a generated `hunk-review` skill with every installation. It is the authoritative machine-facing workflow for session selection, efficient review inspection, navigation, reloads, and comments.

## Install it into your agent

```bash
hunk skill install --agent claude
hunk skill install --agent codex --agent cursor --project
```

| `--agent`  | Reads user skills from                     | Reads project skills from |
| ---------- | ------------------------------------------ | ------------------------- |
| `claude`   | `$CLAUDE_CONFIG_DIR` or `~/.claude/skills` | `.claude/skills`          |
| `codex`    | `$CODEX_HOME` or `~/.codex/skills`         | `.agents/skills`          |
| `opencode` | `~/.config/opencode/skills`                | `.opencode/skills`        |
| `cursor`   | `~/.cursor/skills`                         | `.cursor/skills`          |
| `amp`      | `~/.config/agents/skills`                  | `.agents/skills`          |
| `copilot`  | `~/.copilot/skills`                        | `.github/skills`          |
| `agents`   | `~/.agents/skills`                         | `.agents/skills`          |

`~/.config` follows `$XDG_CONFIG_HOME` when it is set. `--project` writes under the current directory; the default writes under your home directory. Hunk rewrites a pointer it generated earlier, but refuses to replace a hand-written `SKILL.md` unless you pass `--force`.

The installed file is deliberately light. It carries the skill's `name` and `description` so the agent knows when to use it, and its body tells the agent to run:

```bash
hunk skill show
```

That prints the full skill shipped with the installed Hunk version, so the agent always sees instructions that match the CLI on the machine, and upgrading Hunk never requires reinstalling the skill.

## Or install with the skills CLI

The repository also publishes the same pointer skills for the [skills CLI](https://github.com/vercel-labs/skills), which knows the skill directories of many more agents:

```bash
npx skills add modem-dev/hunk -g                       # every detected agent
npx skills add modem-dev/hunk --skill hunk-review -g   # one skill
```

It installs the identical pointer, so `hunk skill install` and `npx skills add` can be mixed freely and both defer to the installed CLI for instructions.

## Locate or read the installed skill

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
