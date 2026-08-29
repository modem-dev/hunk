# Agent workflows

There are two ways to combine Hunk with a coding agent:

- **Recommended:** the agent steers a live Hunk window from another terminal with `hunk session ...`
- **Alternative:** load prewritten agent notes from a JSON sidecar with `--agent-context`

This page is the short human-facing overview. The generated review skill is the
authoritative agent-facing reference for every session command, flag, and error
message — agents should follow the skill, not this page. The hosted guides live
at [hunk.dev/docs](https://hunk.dev/docs/agents/review-with-an-agent/).

## Steer a live Hunk window

1. Open Hunk in one terminal with a normal review command such as `hunk diff` or `hunk show`, and keep it open.
2. In the agent's terminal, locate the bundled skill with `hunk skill path`.
3. Ask the agent to load that file and use it for the review:

```text
Load the Hunk skill and use it for this review. Run `hunk skill path` to get the skill path.
```

The skill teaches the agent to inspect the live session, navigate it, reload
it, and leave inline comments — and to never launch the interactive TUI itself.

## What the agent runs

A typical review looks like:

```bash
hunk session list                            # find live sessions
hunk session review --repo . --json          # file/hunk structure, no raw patch
hunk session navigate --repo . --file src/App.tsx --hunk 2
hunk session comment add --repo . --file src/App.tsx --new-line 42 --summary "Check this boundary"
hunk session reload --repo . -- show HEAD~1  # swap what the window shows
```

- `--repo <path>` selects the session by its loaded repo root; pass a session id instead when several windows share one repo.
- `review --json` keeps raw diff text out of agent context; `--include-patch` opts in per call.
- `comment apply --stdin` applies a JSON batch of notes in one call.

Full syntax, advanced reload targeting (`--session-path`, `--source`), and
error remedies are in the skill
([`skills/hunk-review/SKILL.md`](../skills/hunk-review/SKILL.md)).

## How live session control works

Every normal Hunk TUI registers with a local loopback daemon, and
`hunk session ...` asks that daemon for the right live window. Nothing needs to
be started by hand — `hunk daemon serve` exists only for manual startup or
debugging of the daemon.

If `hunk session list` reports no sessions while Hunk is visibly running, the
agent sandbox is likely blocking loopback access. Probe the daemon directly:

```bash
curl -s -X POST http://127.0.0.1:47657/session-api \
  -H 'content-type: application/json' \
  --data '{"action":"list"}'
```

If that shows sessions, rerun the session command with the agent's
network/sandbox escalation. With a custom `HUNK_MCP_PORT`, use that port
instead.

## Load agent notes from a file

Use `--agent-context` when agent-written rationale already exists as a JSON
sidecar and should render beside the diff:

```bash
hunk diff --agent-context notes.json
hunk patch change.patch --agent-context notes.json
```

For a compact real example, see
[`examples/3-agent-review-demo/agent-context.json`](../examples/3-agent-review-demo/agent-context.json).

## Experimental rich notes (STML)

STML markup note bodies are off by default. Start the review with
`--experimental` to render sidecar `markup` fields and accept live comments
that carry markup:

```bash
hunk --experimental diff --agent-context notes.json
```

Plain-text `summary` fields stay required as the fallback, and a reload cannot
change the launch opt-in. Agents check support via `experimentalFeatures` in
`hunk session context --json` and learn the markup language from
`hunk markup guide`.
