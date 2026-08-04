/**
 * Sample 4 — The boundary. This is the sample about what must NOT change.
 *
 * Two hard constraints in hunk decide how far Effect can go, and both are
 * architectural rather than stylistic. Getting them wrong is how an Effect
 * migration turns into a rewrite.
 */

import { Effect, Runtime, Scope, Exit, Cause } from "effect";
import type { GitFailure } from "./01-typed-errors";
import { describeFailure } from "./01-typed-errors";

// ===========================================================================
// Constraint 1 — the published extension API must stay Effect-free
// ===========================================================================

/**
 * `src/extension-api/types.ts` imports nothing, on purpose, and
 * `scripts/check-pack.ts` fails the build if that ever stops being true:
 *
 *     if (/^\s*import\b/m.test(extensionTypes)) {
 *       throw new Error("The public extension-api/types declaration must remain import-free.");
 *     }
 *
 * So `Effect<A, E, R>` can never appear in a published type. If it did, every
 * extension author would have to install and learn `effect` to typecheck a
 * twenty-line extension, and hunk's Effect version would become part of its
 * public API surface forever.
 *
 * That is not a blocker — it is a boundary, and it wants an explicit
 * conversion layer. The public shape stays promise-and-throw:
 */

/** Published shape. Lives in extension-api/types.ts. Unchanged, import-free. */
export interface PublicVcsAdapter {
  readonly id: string;
  loadPatch(input: { readonly kind: string }): Promise<{ readonly patch: string }>;
}

/** Internal shape. Effect-native, lives behind the boundary. */
export interface InternalVcsAdapter {
  readonly id: string;
  readonly loadPatch: (input: {
    readonly kind: string;
  }) => Effect.Effect<{ readonly patch: string }, GitFailure>;
}

/**
 * Inbound: a third-party extension hands hunk a promise-based adapter.
 *
 * `Effect.tryPromise` lifts it, and the untyped rejection is normalized into
 * hunk's own failure type at exactly one place — which is what
 * `toUserFacingError` in `src/core/errors.ts` does today, just with a type
 * attached to the result.
 */
export const adoptExtensionAdapter = (
  adapter: PublicVcsAdapter,
  normalize: (error: unknown) => GitFailure,
): InternalVcsAdapter => ({
  id: adapter.id,
  loadPatch: (input) =>
    Effect.tryPromise({
      try: () => adapter.loadPatch(input),
      catch: normalize,
    }),
});

/**
 * Outbound: hunk's own bundled backends are Effect-native internally, but the
 * dogfooding rule in CLAUDE.md says they must register through the same public
 * API a third party uses. So they convert back on the way out.
 *
 * `Effect.runPromise` rejects with a `FiberFailure`; unwrapping it here keeps
 * the error an extension author sees identical to today's.
 */
export const publishInternalAdapter = (
  adapter: InternalVcsAdapter,
  runtime: Runtime.Runtime<never>,
): PublicVcsAdapter => ({
  id: adapter.id,
  loadPatch: (input) =>
    Runtime.runPromiseExit(runtime)(adapter.loadPatch(input)).then((exit) =>
      Exit.isSuccess(exit) ? exit.value : Promise.reject(unwrapFailure(exit.cause)),
    ),
});

/** Turn an Effect cause back into the plain Error an extension author expects. */
const unwrapFailure = (cause: Cause.Cause<GitFailure>): Error => {
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some") {
    return Object.assign(new Error(describeFailure(failure.value)), {
      name: "HunkUserError",
    });
  }
  return Cause.squash(cause) as Error;
};

// ===========================================================================
// Constraint 2 — React/OpenTUI owns the UI, and Effect does not render
// ===========================================================================

/**
 * `src/ui` has ~128 `useState`/`useEffect` sites and a Pierre-backed row
 * renderer whose hot path (`src/ui/diff/renderRows.tsx`, 2167 lines) is
 * synchronous and allocation-sensitive. None of that becomes Effect. Effect
 * has no rendering story for OpenTUI, and wrapping pure per-row layout in
 * `Effect.sync` would add allocation to the exact code path the `bench:*`
 * scripts exist to protect.
 *
 * So the boundary is: Effect owns *acquiring and watching*, React owns
 * *rendering*, and one adapter connects them. The shape below is the whole
 * integration — a runtime created once, and a hook that forks scoped work and
 * interrupts it on unmount.
 */

export interface ManagedRuntimeLike {
  readonly runFork: <A, E>(
    effect: Effect.Effect<A, E, Scope.Scope>,
  ) => { readonly interrupt: () => void };
}

/**
 * Sketch of the one React hook that would exist.
 *
 * This is deliberately small. If a migration needs more than this to talk to
 * the UI, the boundary has been drawn in the wrong place — Effect has leaked
 * into rendering, and the perf and readability arguments both get worse.
 *
 * (Written as a plain function rather than a real hook so this spike file has
 * no React dependency.)
 */
export const attachScopedWork = <A, E>(
  runtime: ManagedRuntimeLike,
  work: Effect.Effect<A, E, Scope.Scope>,
): (() => void) => {
  const fiber = runtime.runFork(work);
  // React's cleanup function. Unmount interrupts the fiber, which closes the
  // scope, which closes the file watcher — the whole teardown chain from
  // sample 2, triggered by one return value.
  return () => fiber.interrupt();
};

// ===========================================================================
// What the boundary implies for the plan
// ===========================================================================

/**
 * Both constraints point the same way: Effect can own the *process-shaped*
 * parts of hunk — watching, the session daemon, VCS invocation, startup — and
 * must stop at two places, the published extension types and the render path.
 *
 * That is not a compromise position, it is the actual sizing of the
 * opportunity. Measured against the tree (non-test lines, `wc -l`):
 *
 *   src/ui             24,777   React + synchronous rendering  — stays as is
 *   src/core            9,737   of which ~6,100 is pure parsing/layout
 *                                and ~3,600 is vcs + loaders + watch
 *   src/session         4,283   daemon, sockets, retry          — candidate
 *   src/extensions      4,163   untrusted code, error funnel    — partial
 *   src/extension-api   1,548   published contract              — must not change
 *   src/app               406   startup wiring                  — candidate
 *   ---------------------------
 *   total              45,897
 *
 * The candidate zone — vcs, loaders, watch, session, app — is roughly 8,400
 * lines, about 18% of non-test source. That is the honest ceiling on how much
 * of hunk Effect would actually touch.
 */
export type SizingNote = never;
