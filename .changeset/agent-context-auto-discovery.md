---
"hunkdiff": minor
---

Auto-discover `.hunk/agent-context.json` so agent review notes appear in `hunk diff`
with no flags. Adds an `agent_context` config key (path resolved against the repo root)
and a `--no-agent-context` opt-out, shows agent notes by default when a sidecar loads,
and keeps hunk's own `.hunk/` metadata out of untracked working-tree review noise.
