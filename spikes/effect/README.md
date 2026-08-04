# Effect TS in hunk — investigation

**Status:** spike, not a proposal to merge. Nothing in `src/` was changed.

**Recommendation:** don't migrate now. Take the structural lessons from sample 2
into `watchController` without the dependency, and re-open the question when
Effect v4 goes stable. The reasoning is measured, not aesthetic, and is in
[Costs](#the-costs-measured-not-guessed) below.

---

## What's here

Four runnable sample refactors. All four typecheck under the repo's `strict`
settings; sample 2 ships six passing tests.

| File                                  | Subsystem                     | What it shows                                                             |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `01-typed-errors.ts`                  | `src/core/vcs/git.ts`         | Failures in the type signature instead of in `throw`                      |
| `02-watch-controller.ts` + `.test.ts` | `src/core/watchController.ts` | The big one — 345 lines of hand-rolled concurrency replaced by primitives |
| `03-services-layer.ts`                | `src/app/startup.ts`          | `StartupDeps`' eleven `*Impl` overrides as Layers                         |
| `04-boundary.ts`                      | `src/extension-api`, `src/ui` | Where Effect must stop, and why                                           |

```bash
bun test spikes/effect          # 6 pass
bunx tsc --noEmit --skipLibCheck --strict --target es2022 \
  --module preserve --moduleResolution bundler --types bun spikes/effect/*.ts
```

Read them in order. Each has the "before" — real hunk code, condensed but not
softened — directly above the "after".

---

## Would it be useful?

Partly, and the useful part is smaller than it looks. Measured against the tree
(non-test lines):

| Area                                     | Lines  | Verdict                                                                                                                            |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui`                                 | 24,777 | No. React + synchronous rendering. Effect has no OpenTUI story, and `renderRows.tsx` is the hot path the `bench:*` scripts defend. |
| `src/core` — parsing, diff model, layout | ~6,100 | No. Pure functions. `Effect.sync` around a pure function is ceremony.                                                              |
| `src/core` — vcs, loaders, watch         | ~3,600 | **Yes.** Process spawning, failure translation, file watching.                                                                     |
| `src/session`                            | 4,283  | **Yes.** Daemon lifecycle, sockets, stale sweeps, idle timeouts, retries.                                                          |
| `src/extensions`                         | 4,163  | Partial. The error funnel around untrusted third-party code.                                                                       |
| `src/extension-api`                      | 1,548  | **Never.** Published contract, must stay import-free.                                                                              |
| `src/app`                                | 406    | Yes, but only alongside the above.                                                                                                 |

**About 8,400 lines — 18% of non-test source — is in the zone where Effect earns
its keep.** The other 82% would be churn.

### Where it genuinely wins: the watch controller

`src/core/watchController.ts` is 345 lines of hand-rolled concurrency runtime.
It contains five things Effect has a name for:

| What the file does today                                                                              | What replaces it                                                 |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `WatchControllerClock` seam (`now`/`setTimeout`/`clearTimeout`), injected only so tests can fake time | `TestClock` — no seam in the production type                     |
| Four deadlines collapsed by hand into one chained timer (`schedule()`, `clearTimer()`, `onTimer()`)   | `Effect.raceFirst` + `Effect.sleep`                              |
| An `isClosed()` guard after **every** `await` — four in `beginCheck` alone                            | Fiber interruption. Miss-proof, because there is nothing to miss |
| A `dirty` flag so events during a check replay as one trailing check                                  | Events stay in the `Queue`; the next loop turn takes them        |
| A four-state `sourceStatus` machine so the watcher is never closed twice or leaked                    | `Effect.acquireRelease` bound to a `Scope`                       |

The Effect version is ~120 lines and, importantly, the tests get shorter too:
`watchController.test.ts` is 642 lines, much of it a fake clock and a manual
timer queue. `02-watch-controller.test.ts` covers burst coalescing, the
maximum-delay cap, change detection, safety polling, error survival, and clean
teardown in ~190 lines with no scaffolding.

This is the one place in hunk where I'd say the current code is genuinely
_worse_ than the Effect version, rather than just different.

### Where it wins modestly

- **Typed VCS errors** (sample 1). `src/core/errors.ts` exists to re-discover, at
  runtime and structurally, information the thrower already had. A typed error
  channel makes the CLI formatter exhaustive at compile time. Real, but it's a
  correctness improvement in code that isn't currently producing bugs.
- **`StartupDeps` → Layers** (sample 3). Eleven optional `*Impl` fields means a
  test that forgets a stub silently shells out to real git, and the type system
  is fine with that. Layers make the omission a type error. Also real, also
  modest — and not worth doing on its own.

### Where it does not fit

Sample 4 covers this in detail. Two hard constraints:

1. **`src/extension-api/types.ts` must stay import-free** — `scripts/check-pack.ts`
   fails the build otherwise. `Effect<A, E, R>` can never appear in a published
   type, or every extension author installs `effect` to typecheck twenty lines,
   and hunk's Effect version becomes public API forever. This isn't a blocker,
   but it forces an explicit conversion layer in both directions.
2. **React/OpenTUI owns rendering.** ~128 `useState`/`useEffect` sites and a
   2,167-line synchronous row renderer. Effect doesn't render, and wrapping
   per-row layout in `Effect.sync` adds allocation to exactly the path the
   benchmark suite protects.

---

## The costs, measured not guessed

Everything below is from this machine, this repo, `bun build --compile --minify`,
20 runs per configuration, repeated 3 times.

### Startup — this is the decisive number

hunk's real binary, `--version` (the cheapest possible path):

| Build                                                  | Per invocation | Binary    |
| ------------------------------------------------------ | -------------- | --------- |
| baseline                                               | **~290 ms**    | 135.27 MB |
| + `import { Effect, ... } from "effect"` in `main.tsx` | **~370 ms**    | 135.48 MB |

**+80 ms on every invocation, ~28% slower cold start, for importing Effect —
before running a single `Effect`.** It's module-evaluation cost: the in-process
timer after import shows only 5 ms of actual work.

Binary size is a non-issue (+0.21 MB).

That 80 ms lands on `hunk pager` and `hunk difftool` too, which git spawns on
every `git diff`. For a tool whose pitch is "modern desktop diff tool in a
terminal", that's the wrong direction.

### You cannot lazy-load your way out of it

The obvious mitigation — `await import("effect")` only on the TUI path — is
**worse** in a Bun compiled binary:

| Configuration                               | Per invocation |
| ------------------------------------------- | -------------- |
| No Effect anywhere                          | 14 ms          |
| Eager `import`                              | 78 ms          |
| Dynamic `import()`, Effect **never loaded** | 147 ms         |
| Dynamic `import()`, Effect loaded           | 234 ms         |

A control test — dynamic-importing a one-line module — costs 18 ms, so this is
Effect's module graph, not dynamic-import overhead in general.

There's no architectural escape either: the daemon is spawned as a separate
process but from the _same_ binary (`hunk daemon serve`), and `brokerServer` is
imported at the top of `main.tsx`. Any Effect reachable from `main` taxes every
path. Splitting the daemon into its own compiled binary would work, but that's a
change to the distribution model, not a migration detail.

### But Effect v4 largely fixes it

v4 beta's rewritten runtime, identical import surface, same harness:

| Version                 | Per invocation | Tax        | Modules bundled |
| ----------------------- | -------------- | ---------- | --------------- |
| none                    | 14 ms          | —          | —               |
| `effect@3.22.0`         | 85 ms          | **+71 ms** | 155             |
| `effect@4.0.0-beta.102` | 34 ms          | **+20 ms** | 63              |

**v4 cuts Effect's startup tax by ~72%.** +20 ms is a defensible price; +71 ms
is not. This single measurement is why the recommendation is "wait" rather than
"no".

### Other costs

- **`node_modules` +34 MB** for the dependency. Irrelevant to users, mildly
  annoying for contributors.
- **Learning curve on an OSS project.** hunk takes outside contributions.
  Effect is a large vocabulary — `Effect`, `Layer`, `Scope`, `Fiber`, `Ref`,
  `Schedule`, tagged errors, three type parameters — and a half-migrated
  codebase is harder to contribute to than either endpoint.
- **Version risk.** v3.22.1 is stable; v4 is at `beta.103` with a from-scratch
  runtime rewrite and 17 unstable modules. Adopting v3 today means doing a v4
  migration later. The Effect team says v4 will be an LTS once it stabilizes.
- **Function coloring.** Sample 1 ends on this: `runGitText` has ~14 callers in
  `git.ts` alone. Converting one function forces `Effect.runSync` at every
  un-migrated call site, and `runSync` re-throws failures wrapped in a
  `FiberFailure` — a half-migrated boundary produces _worse_ error messages than
  today. This is why the plan below moves whole subsystems, never single
  functions.

---

## Migration tooling: what actually exists

I went looking for codemods and an official migration guide. The honest answer
is that neither exists.

| Thing                                                                         | Reality                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Official Effect codemod**                                                   | Does not exist. No `@effect/codemod`, nothing in the Effect repo, no jscodeshift/ast-grep transform published by the core team.                                                                                                                                                                                                                                                                                                                                                                                                         |
| **`effect-migrate`** ([repo](https://github.com/aridyckovsky/effect-migrate)) | The only migration tool. It is **not** a codemod — it audits for legacy patterns (async/await, promise constructors, try/catch, barrel imports, boundary violations) and emits JSON context files for AI agents to act on. 6 stars, self-described "dogfooding phase", "APIs may change", explicitly not production-ready. Third-party, built with Amp.                                                                                                                                                                                 |
| **Official migration guide**                                                  | No "migrating an existing codebase" guide. The docs' gradual-adoption story is the interop primitives — `Effect.tryPromise` to enter, `Effect.runPromise` to exit — which is genuinely all the mechanism you need, but it's a paragraph, not a playbook.                                                                                                                                                                                                                                                                                |
| **Official agent skill / `llms.txt`**                                         | No Anthropic-style skill file. There is `llms.txt` on effect.website, and [`tim-smart/effect-mcp`](https://github.com/tim-smart/effect-mcp) (239 stars, `npx -y effect-mcp@latest`, has Claude Code setup instructions) which serves Effect docs over MCP with import-aware package detection. Tim Smart is an Effect core contributor, but the repo isn't branded as official. **This is the highest-value tool to set up if you go forward** — it keeps agents off stale v2/v3 API memory, which matters a lot given the v3→v4 churn. |
| **Prior art**                                                                 | [Inato's fp-ts → Effect migration](https://dev.to/laurerc/how-we-migrated-our-codebase-from-fp-ts-to-effect-5bbk) is the best-documented case: they budgeted 2.5 months and reported it was harder than expected. Note they were migrating _from fp-ts_ — already-functional code — which is a much shorter distance than hunk's starting point.                                                                                                                                                                                        |

So: budget for hand-written migration with agent assistance, not for tooling.
`effect-migrate`'s audit output is worth ~an afternoon to try as a work-list
generator; don't plan around it.

---

## If we went forward: implementation plan

Sequenced so every phase is independently shippable and revertible, and so the
riskiest question is answered first.

### Phase 0 — Decide the startup question (1 day)

Nothing else matters until this is settled.

1. Re-run the numbers above on macOS and Windows (`bench:bootstrap-load` gives
   the harness). Bun's compiled-binary module init may behave differently.
2. Decide the budget explicitly: is +20 ms/invocation acceptable? +80 ms?
3. If the answer is "+20 ms yes, +80 ms no" — which I'd expect — this phase's
   output is **wait for Effect v4 stable**, and phases 1–5 are on hold. That is
   the likely outcome and it is a fine outcome.

**Gate:** a written startup budget in `docs/`. Do not proceed without one.

### Phase 1 — Bring Effect in behind one subsystem (1 week)

- Add `effect` as a real dependency. Pin exactly; no `^`.
- Convert **`watchController` only** — the strongest case, entirely internal, no
  public API surface, and it already has 642 lines of tests to check behavior
  against.
- Keep `createWatchController`'s existing signature as a thin wrapper so
  `useWatchedInput` and the PTY tests don't move yet.
- Port the existing test suite onto `TestClock`; delete `WatchControllerClock`,
  `defaultClock`, and the fake-clock helpers.
- Add a startup-regression check to CI so the tax can't drift silently.

**Gate:** `bun test`, `bun run test:integration`, and the startup check all
pass; watch behavior is unchanged in a real TTY smoke run on a live repo.

**This phase is the one worth doing even if you stop here.**

### Phase 2 — Typed errors at the VCS boundary (1–2 weeks)

- Define the failure taxonomy (sample 1): `GitMissingExecutable`,
  `GitNotARepository`, `GitBadRevision`, `GitCommandFailed`, plus jj/sl
  equivalents.
- Convert `git.ts`, `jujutsu.ts`, `sapling.ts` **as whole files** — every
  internal caller at once, so no `runSync` boundaries appear mid-file.
- The adapter boundary in `src/extensions/` converts back to promise-and-throw
  via sample 4's `publishInternalAdapter`. `HunkUserError` and
  `isUserFacingError` stay exactly as they are — the published shape doesn't
  move.
- Make `formatCliError` exhaustive over the new taxonomy.

**Gate:** `test/cli/` passes unchanged. That suite is the contract; if it needs
edits, the boundary leaked.

### Phase 3 — The session daemon (2–3 weeks)

The highest-value remaining target: stale-session sweeps, idle timeouts,
socket lifetimes, retry, and the launch-lock dance in `brokerLauncher.ts` are
all `Schedule` + `Scope` + `Fiber` problems.

- `packages/session-broker-*` are already separate workspace packages — convert
  them first, in isolation.
- Replace the hand-rolled launch lock and health poll with `Effect.retry` +
  `Schedule.exponential`.
- Keep the HTTP surface and `protocolSchemas.ts` (zod) unchanged. **Do not**
  swap zod for `effect/Schema` in this phase — it's a separate, larger decision
  and bundling it here makes the diff unreviewable.

**Gate:** `test/session/` passes; daemon memory check (`bench:daemon-memory`)
shows no regression.

### Phase 4 — Startup wiring (1 week)

- `StartupDeps` → Layers (sample 3). Only now, when the services it would
  provide are already Effect-native and it's a simplification rather than a
  translation.
- `src/main.tsx` becomes one `Effect.runPromise` / `ManagedRuntime` at the top.

### Phase 5 — Hold the line (ongoing)

- Add a lint rule or `check-pack` assertion that `effect` is not imported from
  `src/ui/**` or `src/extension-api/**`.
- Document the boundary in `docs/source-architecture.md`: Effect owns acquiring
  and watching; React owns rendering; conversion happens at exactly two places.
- Set up `effect-mcp` for contributors using coding agents.

### Explicitly out of scope

- `src/ui` — all of it.
- Pure diff-model, layout, and STML code.
- zod → `effect/Schema`.
- `@effect/platform` for process spawning. hunk uses `Bun.spawnSync`
  deliberately; wrapping it in a portable abstraction is a different project.

**Total if fully executed: 6–8 weeks**, with the caveat that Inato budgeted 2.5
months from a _shorter_ starting distance.

---

## The recommendation, stated plainly

Don't adopt Effect in hunk right now.

The blocker isn't taste — sample 2 makes a real case that `watchController` is
worse today than it needs to be. The blocker is that hunk is a per-invocation
CLI that git spawns as a pager, Effect v3 costs it 80 ms on every start, and
lazy-loading makes that worse rather than better. 18% of the source in the
useful zone doesn't buy that back.

Three things I'd do instead:

1. **Steal sample 2's structure without the dependency.** Scope-bound teardown
   and queue-instead-of-dirty-flag are patterns, not library features. Most of
   the 345 → 120 line reduction is available for the price of a refactor.
2. **Write down a startup budget.** hunk has eleven benchmark scripts and no
   stated cold-start target. This investigation needed one to answer its own
   question, and the next dependency decision will too.
3. **Re-measure when Effect v4 ships stable.** +20 ms is a different
   conversation than +71 ms. The v4 numbers above are the concrete trigger to
   re-open this — not a vague "revisit later".

What would change my mind today: evidence that hunk's users don't feel cold
start (if it's overwhelmingly launched interactively and left running, 80 ms is
noise), or a decision to build the daemon as a separate binary — which would let
Effect into `src/session` at zero cost to the CLI path.

---

## Appendix — reproducing the measurements

```bash
# Baseline binary
bun build --compile --minify src/main.tsx --outfile /tmp/hunk-baseline
time (for i in $(seq 1 20); do /tmp/hunk-baseline --version >/dev/null; done)

# With Effect imported in main.tsx, same harness.
# v3 vs v4: identical import surface, `bun add effect@<version>`, compile, time.
```

`effect@3.22.0` is a devDependency on this branch so `bun test spikes/effect`
runs. Deleting `spikes/` and that dependency reverts the branch to a no-op.
