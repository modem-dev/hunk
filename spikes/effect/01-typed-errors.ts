/**
 * Sample 1 — Typed errors at the VCS boundary.
 *
 * Real code: `runGitCommand` / `runGitText` in `src/core/vcs/git.ts`.
 *
 * This is the smallest, least invasive thing Effect buys you, and the easiest
 * to argue about on its own merits. Read `before` and `after` side by side.
 */

import { Data, Effect } from "effect";

// ---------------------------------------------------------------------------
// Shared shapes (condensed from src/core/vcs/git.ts)
// ---------------------------------------------------------------------------

export interface GitBackedInput {
  kind: "vcs" | "show" | "stash-show";
  ref?: string;
  range?: string;
}

export interface RunGitOptions {
  input: GitBackedInput;
  args: string[];
  cwd?: string;
  gitExecutable?: string;
  acceptedExitCodes?: number[];
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Stand-in for Bun.spawnSync so this file runs without touching a real repo. */
declare const spawnGit: (
  executable: string,
  args: string[],
  cwd: string,
) => { stdout: Uint8Array; stderr: Uint8Array; exitCode: number };

// ===========================================================================
// BEFORE — what hunk does today
// ===========================================================================

export class HunkUserErrorLike extends Error {
  suggestions: string[];
  constructor(message: string, suggestions: string[] = []) {
    super(message);
    this.name = "HunkUserError";
    this.suggestions = suggestions;
  }
}

export function runGitCommandBefore({
  input,
  args,
  cwd = process.cwd(),
  gitExecutable = "git",
  acceptedExitCodes = [0],
}: RunGitOptions): GitCommandResult {
  let proc: ReturnType<typeof spawnGit>;

  try {
    proc = spawnGit(gitExecutable, args, cwd);
  } catch (error) {
    // Throws. Nothing in the signature says so.
    throw translateSpawnFailureBefore(input, error, gitExecutable);
  }

  const stdout = Buffer.from(proc.stdout).toString("utf8");
  const stderr = Buffer.from(proc.stderr).toString("utf8");

  if (!acceptedExitCodes.includes(proc.exitCode)) {
    // Also throws. Also invisible.
    throw translateExitFailureBefore(input, stderr.trim());
  }

  return { stdout, stderr, exitCode: proc.exitCode };
}

function translateSpawnFailureBefore(input: GitBackedInput, error: unknown, executable: string) {
  if (error instanceof Error && error.message.includes("Executable not found in $PATH")) {
    return new HunkUserErrorLike(`Could not run ${executable}.`, ["Install git and retry."]);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function translateExitFailureBefore(input: GitBackedInput, stderr: string) {
  if (stderr.includes("not a git repository")) {
    return new HunkUserErrorLike("Not inside a git repository.", ["Run hunk from a repo."]);
  }
  if (input.kind === "stash-show") {
    return new HunkUserErrorLike("No stash entry to show.");
  }
  return new HunkUserErrorLike(stderr || "git failed.");
}

/**
 * The problem this creates for a caller.
 *
 * `runGitCommandBefore` returns `GitCommandResult`. That is a lie of omission:
 * it can throw a missing-executable error, a not-a-repo error, a bad-revision
 * error, or a genuine bug. A caller that wants to recover from exactly one of
 * those has to catch everything, re-inspect it structurally, and re-throw the
 * rest — which is what `toUserFacingError` / `isUserFacingError` in
 * `src/core/errors.ts` exist to do. Nothing checks that the caller got it right.
 */
export function callerBefore(input: GitBackedInput): string | null {
  try {
    return runGitCommandBefore({ input, args: ["rev-parse", "--show-toplevel"] }).stdout.trim();
  } catch (error) {
    // Was that "no repo here" (fine, return null) or "git is broken" (should
    // surface)? We have to ask the error at runtime, and we can silently get
    // it wrong forever.
    if (error instanceof HunkUserErrorLike && error.message.includes("Not inside")) {
      return null;
    }
    throw error;
  }
}

// ===========================================================================
// AFTER — the same function in Effect
// ===========================================================================

/**
 * Failures are declared as data, one class per distinguishable cause.
 * `Data.TaggedError` gives each a `_tag` the compiler can discriminate on.
 */
export class GitMissingExecutable extends Data.TaggedError("GitMissingExecutable")<{
  readonly executable: string;
}> {}

export class GitNotARepository extends Data.TaggedError("GitNotARepository")<{
  readonly cwd: string;
}> {}

export class GitBadRevision extends Data.TaggedError("GitBadRevision")<{
  readonly ref: string;
  readonly stderr: string;
}> {}

export class GitCommandFailed extends Data.TaggedError("GitCommandFailed")<{
  readonly args: readonly string[];
  readonly stderr: string;
  readonly exitCode: number;
}> {}

export type GitFailure =
  | GitMissingExecutable
  | GitNotARepository
  | GitBadRevision
  | GitCommandFailed;

/**
 * Run one git command.
 *
 * The return type now says everything the function can do: it produces a
 * `GitCommandResult`, or fails with exactly one of four named causes. There is
 * no third possibility — an unexpected throw becomes a *defect*, which is a
 * different channel that never gets confused with an expected failure.
 */
export function runGitCommand({
  input,
  args,
  cwd = process.cwd(),
  gitExecutable = "git",
  acceptedExitCodes = [0],
}: RunGitOptions): Effect.Effect<GitCommandResult, GitFailure> {
  return Effect.gen(function* () {
    const proc = yield* Effect.try({
      try: () => spawnGit(gitExecutable, args, cwd),
      catch: (error) =>
        error instanceof Error && error.message.includes("Executable not found in $PATH")
          ? new GitMissingExecutable({ executable: gitExecutable })
          : new GitCommandFailed({ args, stderr: String(error), exitCode: -1 }),
    });

    const stdout = Buffer.from(proc.stdout).toString("utf8");
    const stderr = Buffer.from(proc.stderr).toString("utf8");

    if (!acceptedExitCodes.includes(proc.exitCode)) {
      return yield* translateExitFailure({ input, args, cwd, stderr: stderr.trim(), proc });
    }

    return { stdout, stderr, exitCode: proc.exitCode };
  });
}

/** Map git's stderr onto one named failure. Same logic as today, typed result. */
function translateExitFailure({
  input,
  args,
  cwd,
  stderr,
  proc,
}: {
  input: GitBackedInput;
  args: string[];
  cwd: string;
  stderr: string;
  proc: { exitCode: number };
}): Effect.Effect<never, GitFailure> {
  if (stderr.includes("not a git repository")) {
    return Effect.fail(new GitNotARepository({ cwd }));
  }

  if (stderr.includes("unknown revision")) {
    return Effect.fail(new GitBadRevision({ ref: input.ref ?? input.range ?? "HEAD", stderr }));
  }

  return Effect.fail(new GitCommandFailed({ args, stderr, exitCode: proc.exitCode }));
}

/**
 * The same caller, after.
 *
 * `catchTag` recovers from exactly one named failure and leaves the rest in the
 * error channel. The resulting type is
 * `Effect<string | null, GitMissingExecutable | GitBadRevision | GitCommandFailed>`
 * — the compiler now knows "not a repo" is handled and the others are not.
 * Delete the `catchTag` and the type changes; add a fifth failure to
 * `GitFailure` and every caller that claimed to be exhaustive stops compiling.
 */
export function caller(input: GitBackedInput) {
  return runGitCommand({ input, args: ["rev-parse", "--show-toplevel"] }).pipe(
    Effect.map((result) => result.stdout.trim()),
    Effect.catchTag("GitNotARepository", () => Effect.succeed(null)),
  );
}

/**
 * Exhaustive rendering, checked at compile time.
 *
 * This is the payoff that `src/core/errors.ts` cannot give you today: the CLI
 * formatter is forced to have an arm for every failure the VCS layer can
 * produce, and adding a new one is a type error rather than a fallthrough to a
 * generic message.
 */
export function describeFailure(failure: GitFailure): string {
  switch (failure._tag) {
    case "GitMissingExecutable":
      return `hunk: could not run ${failure.executable}.`;
    case "GitNotARepository":
      return `hunk: ${failure.cwd} is not inside a repository.`;
    case "GitBadRevision":
      return `hunk: unknown revision ${failure.ref}.`;
    case "GitCommandFailed":
      return `hunk: git ${failure.args.join(" ")} failed (${failure.exitCode}).`;
  }
}

// ===========================================================================
// The honest cost
// ===========================================================================

/**
 * Every synchronous caller of `runGitText` — and there are ~14 in git.ts alone
 * — has to become an Effect too, or pay for a `runSync` at the call site.
 * `Effect.runSync` re-throws failures as a wrapped `FiberFailure`, so a
 * half-migrated call site is *worse* than today: it throws something with a
 * less useful message than the original error.
 *
 * That is the "coloring" problem, and it is the single biggest practical cost
 * of adopting Effect. It is why the migration plan pushes the boundary outward
 * in whole subsystems rather than converting individual functions.
 */
export function halfMigratedCallSite(input: GitBackedInput): string {
  // Works, but the failure now arrives as a FiberFailure wrapping GitFailure.
  return Effect.runSync(runGitCommand({ input, args: ["status"] })).stdout;
}
