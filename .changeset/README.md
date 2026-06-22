# Changesets

Hunk uses [Changesets](https://github.com/changesets/changesets) for release-note fragments and npm version preparation.

For user-visible changes, add a changeset instead of editing `CHANGELOG.md` directly:

```bash
bun run changeset
```

Select `hunkdiff` and choose the semver bump that matches the shipped CLI/package change:

- `patch` for fixes and small behavior changes
- `minor` for new user-facing features
- `major` for breaking changes

`package.json` intentionally lists `"."` in `workspaces` so Changesets can discover the root `hunkdiff` package. Keep that entry unless Hunk moves the publishable package out of the repository root.

For maintenance-only PRs that should not appear in release notes, create an empty changeset:

```bash
bun run changeset -- --empty
```

Release prep runs:

```bash
bun run release:version
```

That consumes the pending `.changeset/*.md` files, updates `CHANGELOG.md`, and bumps package versions for the release commit.
