# @hunk/git

Private, statically bundled Git provider for Hunk. This `0.0.0` workspace is not a public or
versioned SDK.

The package exports its provider from `src/index.ts`. It supports working-tree, revision, and stash
reviews; history; exact old/new source reads; staged changes; untracked and large-file handling;
and filesystem-assisted watch plans.

Provider code may import local modules, platform built-ins, the public `hunkdiff/extension`
contract, and explicit `@hunk/vcs/*` leaves. It must not import Hunk core, app, session, or UI
internals.

Hunk registers the provider in `packages/hunk/src/extensions/default/vcs/index.ts` and composes it
into the provider-neutral catalog in `packages/hunk/src/app/vcsCatalog.ts`. Keep tests beside the
provider source. Run `bun test packages/hunk-git` and `bun run deps:check` after changes.
