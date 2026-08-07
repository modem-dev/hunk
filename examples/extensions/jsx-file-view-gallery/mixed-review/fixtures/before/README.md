# Review Console

Review Console is a terminal workspace for inspecting release changes before they ship.

## Quick start

1. Install dependencies with `bun install`.
2. Run `bun run dev`.
3. Open the review URL printed by the command.

## Review workflow

The default workflow loads a changeset, groups files by directory, and opens the first hunk.
Reviewers can move between hunks, leave notes, and export a text summary.

### Keyboard controls

- `[` selects the previous hunk.
- `]` selects the next hunk.
- `/` focuses the file filter.
- `q` exits the review.

## Configuration

Configuration is loaded from `review.config.json` in the current directory.
The file may define a theme, a default layout, and ignored paths.

```json
{
  "theme": "midnight",
  "layout": "split",
  "ignored": ["dist/**"]
}
```

## CI integration

Use `bun run review --check` in CI. The command exits non-zero when unresolved notes remain.
Generated reports are written to `artifacts/review.txt`.

## Security

Repository configuration is treated as data and never executes code.
Keep access tokens in the environment rather than committing them to configuration files.

## Support

Open an issue with the terminal type, operating system, and a minimal patch that reproduces the problem.
