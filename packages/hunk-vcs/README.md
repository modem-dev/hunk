# @hunk/vcs

Private implementation helpers shared by Hunk's bundled VCS providers. This `0.0.0` workspace is
not a public or versioned SDK.

The package has no root export. Providers import only the leaf they need:

- `@hunk/vcs/async-process`
- `@hunk/vcs/diff-target`
- `@hunk/vcs/large-file`
- `@hunk/vcs/path`
- `@hunk/vcs/source`

`@hunk/vcs` sits at the bottom of the workspace graph and does not import other workspace packages.
Provider implementations combine these helpers with the public `hunkdiff/extension` contract; Hunk
registers them in `packages/hunk/src/extensions/default/vcs/index.ts` and composes the catalog in
`packages/hunk/src/app/vcsCatalog.ts`.

Keep unit tests beside the source. Run `bun test packages/hunk-vcs` and `bun run deps:check` after
changing this package.
