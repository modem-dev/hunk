# Review Console

Review Console is a terminal workspace for understanding release changes before they ship.

## Quick start

1. Install dependencies with `bun install`.
2. Run `bun run dev -- --watch`.
3. Open the review URL printed by the command.
4. Press `?` at any time to inspect the active command map.

## Review workflow

The default workflow loads a changeset, preserves its narrative file order, and opens the first hunk.
Reviewers can move between hunks, leave notes, preview semantic file views, and export a Markdown summary.

### Keyboard controls

- `[` selects the previous hunk.
- `]` selects the next hunk.
- `/` focuses the file filter.
- `F8` toggles the installed semantic preview for the selected file.
- `q` exits the review.

## Configuration

Configuration is layered from user settings and `review.config.json` in the current directory.
The repository file may define a theme, default layout, ignored paths, and extension folders.

```json
{
  "theme": "midnight",
  "layout": "unified",
  "ignored": ["dist/**"],
  "extensions": ["./review-extensions"]
}
```

## CI integration

Use `bun run review --check --format markdown` in CI. The command exits non-zero when unresolved notes remain.
Generated reports are written to `artifacts/review.md` and include stable file and hunk links.

## Security

Repository extensions run only after an explicit trust decision.
Keep access tokens in the environment rather than committing them to configuration files.

## Support

Open an issue with the terminal type, operating system, active extensions, and a minimal patch that reproduces the problem.
