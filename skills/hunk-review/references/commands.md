# Hunk commands for Pi

## Source repo vs installed CLI

Launching Hunk normally should auto-start/register the local session daemon when MCP is enabled, so Pi usually does not need to run `hunk mcp serve` first.

If Pi is operating inside the Hunk source repo, prefer the source entrypoint so review and validation target the current checkout:

```bash
bun run src/main.tsx -- diff
bun run src/main.tsx -- show HEAD~1
bun run src/main.tsx -- patch -
bun run src/main.tsx -- pager
```

Otherwise use the installed CLI:

```bash
hunk diff
hunk show
hunk patch -
hunk pager
```

## Common review entrypoints

### Review working tree changes

```bash
hunk diff
hunk diff --staged
hunk diff main...feature
```

### Review commits

```bash
hunk show
hunk show HEAD~1
hunk stash show
```

### Review direct file pairs

```bash
hunk diff before.ts after.ts
```

### Review patch input

```bash
git diff --no-color | hunk patch -
```

### Review with agent rationale sidecar

```bash
hunk diff --agent-context path/to/context.json
```

Use this when you already have a sidecar file for local review context. `.hunk/latest.json` is one optional convention, not a required repo workflow.

## TTY guidance

For interactive verification:

- prefer a real terminal or tmux pane
- do not rely on redirected stdout captures for behavior verification
- if testing local Hunk source changes, use `bun run src/main.tsx -- ...` instead of an installed `hunk` binary
