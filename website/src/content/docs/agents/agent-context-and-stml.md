---
title: Agent context and experimental STML notes
description: Load review rationale from a sidecar and opt into rich terminal-native note markup.
---

Live session comments are the recommended workflow. A sidecar is useful when the annotations already exist before Hunk starts or need to travel with a patch.

## Load a JSON sidecar

```bash
hunk diff --agent-context notes.json
hunk patch change.patch --agent-context notes.json
```

The sidecar can set narrative file order and attach hunk-level annotations. Keep it concise: one changeset summary, short file summaries, and only rationale that improves the review. The visible UI prioritizes hunk notes rather than generic explainer cards.

A compact example lives at `examples/3-agent-review-demo/agent-context.json` in the repository.

## Opt into STML

STML is experimental rich markup for terminal note bodies. It is off by default:

```bash
hunk --experimental diff --agent-context notes.json
```

The launch flag is the authority for that session; a reload cannot turn the capability on later. Plain `summary` text remains required as the fallback.

Before sending markup, an agent should inspect support and width:

```bash
hunk session context --repo . --json
hunk markup guide
hunk markup render - --width <reported-noteMarkupWidth>
```

Only send `--markup` when `experimentalFeatures` includes `stml`. Keep colors symbolic and markup compact so notes retain a clear spatial relationship to their code.
