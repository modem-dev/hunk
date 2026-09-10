# @hunk/sapling

Private, statically bundled Sapling provider for Hunk. This `0.0.0` workspace is not a public or
versioned SDK.

The package exports its provider from `src/index.ts`. It supports working-copy and revision reviews,
untracked-file discovery, and signature-based refresh. History, staged and stash reviews, exact
source reads, and filesystem watch plans are not supported.

Provider code may import local modules, platform built-ins, the public `hunkdiff/extension`
contract, and explicit `@hunk/vcs/*` leaves. It must not import Hunk core, app, session, or UI
internals.

Hunk registers the provider in `packages/hunk/src/extensions/default/vcs/index.ts` and composes it
into the provider-neutral catalog in `packages/hunk/src/app/vcsCatalog.ts`. Keep tests beside the
provider source. Run `bun test packages/hunk-sapling` and `bun run deps:check` after changes.
