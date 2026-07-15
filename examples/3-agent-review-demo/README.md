# 3-agent-review-demo

A flagship Hunk demo: a small command-palette refactor with inline agent rationale attached to the interesting hunks.

## Run

```bash
hunk patch examples/3-agent-review-demo/change.patch \
  --agent-context examples/3-agent-review-demo/agent-context.json
```

## What to look for

- the PR-style overview that opens first (`o` to toggle): a changeset title and a
  rendered-markdown description explaining the change as a whole
- query normalization extracted into its own helper
- ranking logic that prefers strong matches over loose substring hits
- inline notes beside the changed hunks themselves, kept close to the code they
  explain rather than collapsed into the overview
