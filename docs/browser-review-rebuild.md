# Browser review rebuild plan

The synchronized browser-review feature (originally prototyped in one large branch) lands as a
stack of small, independently reviewable PRs. Each phase has a hard gate and stands on the
previous one. The seam contract — shared primitives stay renderer-free and platform-neutral —
is enforced by `scripts/source-boundaries.test.ts`, whose debt lists may only shrink.

## Phase 0 — seam contract and guardrails (this doc)

- Boundary gates for `src/core/review/` (the shared review model), `src/session/reviewProtocol.ts`
  (the wire schema), and `src/web/` (the browser client). The gates tolerate absent trees, so
  they land ahead of the code they constrain.
- A shrink-only debt map for the Node-only primitives the prototype's model files still carry;
  each entry must be repaid with a platform-neutral implementation before a browser bundle may
  import that file.
- The existing architecture boundaries stay at full strength. The prototype relocated bundled
  VCS providers into `src/core/vcs/` and weakened this suite to compensate; that relocation must
  not ride along with any rebuild phase — extraction PRs land against the restored gates.

## Phase 1 — review model + terminal adoption (two PRs)

1. **Review store**: `state / actions / reducer / store / intents / selectors` in
   `src/core/review/`, with `useReviewController` / `App` / `AppHost` refactored onto it in the
   same PR. Behavior-neutral; existing PTY integration tests must pass untouched.
2. **Review document projection**: `document / identity / sourceIdentity / anchors /
contentManifest / notes / expansion / reconcile / jsonStream`, adopted by the terminal.
   Note-anchor ranges use full per-side extents (`*Count`), not changed-line counts (`*Lines`),
   fixed once here in shared code.

Gate: `bun test`, `bun run test:integration`, seam boundary tests.

## Phase 2 — producer runtime

`src/app/reviewSessionRuntime.ts`: generations, snapshot serving, resource materialization,
serving the existing `hunk session` surface only. Resource read failures map to distinct error
codes (integrity failures are never collapsed into `unknown-resource`).

Gate: `test/session/` integration suite.

## Phase 3 — wire protocol + broker mirror

`reviewProtocol.ts`, broker `wire.ts` validation, broker review mirror, `reviewResourceCache`
(bounded in-flight budget). Patch reconstruction for `hunk session review --include-patch` uses
bounded-parallel loads from day one. Valuable without any web UI: agents get chunked,
digest-verified, memory-bounded resource access.

Gate: broker suites and `reviewResources.integration.test.ts`, including the parallel-load test.

## Phase 4 — HTTP surface, no client

`browserReviewServer` + capability auth + SSE, loopback-only, tested with plain `fetch`.
Auth sessions renew (a review must be able to outlive the initial cookie TTL) and Range
handling covers zero-length resources.

Gate: HTTP-contract tests; security review focused on this PR alone.

## Phase 5 — browser client (two PRs)

1. **Read-only mirror**: `apiClient` / `mirror` / `pierreDocument` / review stream rendering a
   snapshot with Pierre. No actions, no note editing.
2. **Interactivity**: action dispatch through the broker, selection sync, note editing,
   watch/reload generation swaps.

Gate: browser test suite, split to match the two cuts; web seam boundary test.

## Phase 6 — entry points and packaging

- `--web` / `--no-open` / `hunk session open` / `--tailscale` CLI wiring. The review URL is
  always recoverable from the terminal, and the opener preserves URL fragments on every
  platform (no `rundll32`).
- Offline browser assets are generated at build/release time or diff-checked by a script gate,
  not hand-maintained compiled output.

Gate: CLI contract tests, offline-asset check, real terminal + browser smoke run.
