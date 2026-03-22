# Hunk live review flow

Hunk uses one local-only loopback daemon to broker commands to one or more live Hunk review sessions.

## Daemon model

- Normal Hunk sessions auto-start and register with the daemon when MCP is enabled.
- Manual startup is available via:

```bash
hunk mcp serve
```

- Disable daemon registration for one Hunk session with:

```bash
HUNK_MCP_DISABLE=1 hunk diff
```

## User and agent interface

The review-oriented interface is `hunk session ...`:

- `hunk session list`
- `hunk session get`
- `hunk session context`
- `hunk session navigate`
- `hunk session comment add`
- `hunk session comment list`
- `hunk session comment rm`
- `hunk session comment clear --yes`

## Recommended review flow

### 1. Discover the target session

Run `hunk session list` first.

If no session exists but the user wants interactive review, launch Hunk (`hunk diff`, `hunk show`, or the source entrypoint in this repo), then come back and run `hunk session list` again.

Use explicit `sessionId` or `--repo <path>` whenever more than one live session exists.

### 2. Inspect current focus

Run `hunk session context` to see:

- current file
- current hunk index
- selected hunk old/new ranges
- whether agent notes are visible
- live comment count

This is the best way to respect what the human reviewer is already looking at.

### 3. Move only when needed

If the current focus is wrong, run `hunk session navigate` with either:

- `--hunk <n>`, or
- `--old-line <n>` / `--new-line <n>`

Prefer hunk-level movement over adding broader remote-control actions.

### 4. Leave inline review notes

Run `hunk session comment add` with:

- `<session-id>` or `--repo <path>`
- `--file`
- `--old-line` or `--new-line`
- `--summary`
- optional `--rationale`
- optional `--author`

Use concise review comments tied to actual diff lines.

## Practical guidance for Pi

- Prefer `hunk session ...` over scraping terminal text when a live Hunk session already exists.
- Use `hunk session get` when you need broad session metadata; use `hunk session context` for fast focus-aware checks.
- In multi-session setups, never assume the sole-session fallback is still safe after new windows open.
- Keep comments review-oriented rather than conversational.
- If the user wants silent inspection rather than visible interaction, avoid unnecessary navigation and only comment when asked.
