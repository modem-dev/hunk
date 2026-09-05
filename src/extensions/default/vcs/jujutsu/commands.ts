import {
  HunkExtensionUserError,
  type ExtensionVcsDiffInput,
  type ExtensionVcsRangeEndpoints,
  type ExtensionVcsShowInput,
} from "hunkdiff/extension";
import { normalizePathForOS } from "../../../../lib/osPath";
import { describeDiffTargets } from "../diffRange";
import { runAbortableCommand } from "../asyncProcess";

export type JjBackedInput = ExtensionVcsDiffInput | ExtensionVcsShowInput;

export interface RunJjTextOptions {
  input: JjBackedInput;
  args: string[];
  cwd?: string;
  jjExecutable?: string;
  signal?: AbortSignal;
}

/** Identifies the reviewed new commit and every commit JJ used to build the old side. */
export interface JjDiffEndpoints {
  newCommitId: string;
  oldCommitIds: string[];
}

/** Bypass user template aliases while rendering full commit IDs. */
const JjCommitIdTemplate = 'self.commit_id() ++ "\\n"';

/** Parse newline-delimited full commit IDs emitted by a Jujutsu template. */
function parseJjCommitIds(output: string) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]+$/i.test(line));
}

/** Reject a Jujutsu revision that could be interpreted as a command option. */
export function requireJjRevisionArg(input: JjBackedInput, value: string) {
  if (value.length === 0) {
    throw new HunkExtensionUserError(
      `\`${formatJjCommandLabel(input)}\` refused an empty revision.`,
      {
        suggestions: ["Pass a non-empty revision or revset and try again."],
      },
    );
  }
  if (value.startsWith("-")) {
    throw new HunkExtensionUserError(
      `\`${formatJjCommandLabel(input)}\` refused revision \`${value}\` because it looks like a Jujutsu option.`,
      { suggestions: ["Pass a plain revision or revset and try again."] },
    );
  }
  return value;
}

/** Append Jujutsu filesets only when the caller requested path filtering. */
function appendJjFilesets(args: string[], pathspecs?: string[]) {
  if (!pathspecs || pathspecs.length === 0) {
    return;
  }

  args.push("--", ...pathspecs);
}

/** Build the `jj diff --git` arguments for working-copy, revset, and two-revision reviews. */
export function buildJjDiffArgs(
  input: ExtensionVcsDiffInput,
  pinned?: string | ExtensionVcsRangeEndpoints,
  snapshotWorkingCopy = false,
) {
  const args = ["diff", "--git"];
  const endpoints = typeof pinned === "object" ? pinned : input.rangeEndpoints;

  if (endpoints) {
    // A `from..to` revset selects commits between two points; it does not compare their trees.
    // Pinning resolved endpoints also lets the second command avoid another workspace snapshot.
    const from = requireJjRevisionArg(input, endpoints.from);
    const to = requireJjRevisionArg(input, endpoints.to);
    args.push(
      ...(snapshotWorkingCopy ? [] : ["--ignore-working-copy"]),
      "--from",
      from,
      "--to",
      to,
    );
  } else if (typeof pinned === "string" || input.range) {
    args.push("-r", typeof pinned === "string" ? pinned : input.range!);
  }

  appendJjFilesets(args, input.pathspecs);
  return args;
}

/** Build the `jj diff --git -r` arguments used for `hunk show` in Jujutsu mode. */
export function buildJjShowArgs(input: ExtensionVcsShowInput, pinnedRevision?: string) {
  const args = ["diff", "--git", "-r", pinnedRevision ?? input.ref ?? "@"];

  appendJjFilesets(args, input.pathspecs);
  return args;
}

export function formatJjCommandLabel(input: JjBackedInput) {
  if (input.kind === "vcs") {
    if (input.staged) {
      return "hunk diff --staged";
    }

    const targets = describeDiffTargets(input);
    return targets ? `hunk diff ${targets}` : "hunk diff";
  }

  return input.ref ? `hunk show ${input.ref}` : "hunk show";
}

function trimJjPrefix(message: string) {
  return message.replace(/^error:\s*/i, "").trim();
}

function firstJjErrorLine(stderr: string) {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);

  return trimJjPrefix((line ?? stderr.trim()) || "Jujutsu command failed.");
}

function isMissingJjRepoMessage(stderr: string) {
  return ["There is no jj repo in", "not in a workspace"].some((fragment) =>
    stderr.includes(fragment),
  );
}

function isInvalidRevsetMessage(stderr: string) {
  return [
    "Failed to parse revset",
    "Revision not found",
    "No such revision",
    "doesn't exist",
    "is ambiguous",
    "Revset expression resolved to no revisions",
  ].some((fragment) => stderr.includes(fragment));
}

function createMissingJjExecutableError(input: JjBackedInput, jjExecutable: string) {
  return new HunkExtensionUserError(
    `Jujutsu is required for \`${formatJjCommandLabel(input)}\` when \`vcs = "jj"\`, but \`${jjExecutable}\` was not found in PATH.`,
    { suggestions: ['Install Jujutsu or set `vcs = "git"` in Hunk config, then try again.'] },
  );
}

function createMissingJjRepoError(input: JjBackedInput) {
  return new HunkExtensionUserError(
    `\`${formatJjCommandLabel(input)}\` must be run inside a Jujutsu repository when \`vcs = "jj"\`.`,
    {
      suggestions: [
        'Run the command from a Jujutsu checkout, or set `vcs = "git"` in Hunk config.',
      ],
    },
  );
}

export function createJjStagedError(input: ExtensionVcsDiffInput) {
  return new HunkExtensionUserError(
    `\`${formatJjCommandLabel(input)}\` requires Git VCS mode because Jujutsu has no staging area.`,
    { suggestions: ['Remove `--staged`, or set `vcs = "git"` in Hunk config.'] },
  );
}

function createInvalidRevsetError(input: JjBackedInput) {
  if (input.kind === "vcs" && input.rangeEndpoints) {
    const { from, to } = input.rangeEndpoints;
    return new HunkExtensionUserError(
      `\`${formatJjCommandLabel(input)}\` could not resolve Jujutsu revisions \`${from}\` and \`${to}\`.`,
      { suggestions: ["Check both revisions and try again."] },
    );
  }

  const revset = input.kind === "vcs" ? input.range : (input.ref ?? "@");
  return new HunkExtensionUserError(
    `\`${formatJjCommandLabel(input)}\` could not resolve Jujutsu revset \`${revset}\`.`,
    { suggestions: ["Check the revset and try again."] },
  );
}

function createGenericJjError(input: JjBackedInput, stderr: string) {
  return new HunkExtensionUserError(`\`${formatJjCommandLabel(input)}\` failed.`, {
    suggestions: [firstJjErrorLine(stderr)],
  });
}

function translateJjSpawnFailure(
  input: JjBackedInput,
  error: unknown,
  jjExecutable: string,
): Error {
  if (error instanceof HunkExtensionUserError) {
    return error;
  }

  if (error instanceof Error && error.message.includes("Executable not found in $PATH")) {
    return createMissingJjExecutableError(input, jjExecutable);
  }

  return error instanceof Error ? error : new Error(String(error));
}

function translateJjExitFailure(input: JjBackedInput, stderr: string) {
  if (isMissingJjRepoMessage(stderr)) {
    return createMissingJjRepoError(input);
  }

  if (isInvalidRevsetMessage(stderr)) {
    return createInvalidRevsetError(input);
  }

  return createGenericJjError(input, stderr);
}

/** Spawn one Jujutsu command and accept only declared non-error exit codes. */
function runJjCommand({ input, args, cwd = process.cwd(), jjExecutable = "jj" }: RunJjTextOptions) {
  let proc: ReturnType<typeof Bun.spawnSync>;
  const command = [jjExecutable, "--no-pager", "--color", "never", ...args];

  try {
    proc = Bun.spawnSync(command, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw translateJjSpawnFailure(input, error, jjExecutable);
  }

  const stdout = Buffer.from(proc.stdout ?? []).toString("utf8");
  const stderr = Buffer.from(proc.stderr ?? []).toString("utf8");

  if (proc.exitCode !== 0) {
    throw translateJjExitFailure(input, stderr.trim() || `Command failed: ${command.join(" ")}`);
  }

  return {
    stdout,
    exitCode: proc.exitCode,
  };
}

/** Run a Jujutsu command and translate common failures into user-facing Hunk errors. */
export function runJjText(options: RunJjTextOptions) {
  return runJjCommand(options).stdout;
}

/** Run a Jujutsu command asynchronously so embedded review preparation stays cancellable. */
export async function runJjTextAsync({
  input,
  args,
  cwd = process.cwd(),
  jjExecutable = "jj",
  signal,
}: RunJjTextOptions): Promise<string> {
  const command = [jjExecutable, "--no-pager", "--color", "never", ...args];
  let result: Awaited<ReturnType<typeof runAbortableCommand>>;
  try {
    result = await runAbortableCommand(command, { cwd, signal });
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw translateJjSpawnFailure(input, error, jjExecutable);
  }
  if (result.exitCode !== 0) {
    throw translateJjExitFailure(
      input,
      result.stderr.trim() || `Command failed: ${command.join(" ")}`,
    );
  }
  return result.stdout;
}

/**
 * Resolve a JJ revset once so the patch and later source reads use the same commit.
 *
 * A patch contains only changed lines and a small amount of surrounding context. Hunk
 * therefore waits until a user expands a gap before loading the complete file. Names
 * such as `@` and bookmarks can move between those two moments, so this lookup returns
 * full commit IDs that callers reuse for both patch generation and `jj file show`.
 * The first lookup intentionally allows JJ to snapshot the working copy so `@` includes
 * current filesystem changes; commands that use the returned IDs can then pass
 * `--ignore-working-copy` because the commit has already been fixed.
 *
 * A revset that selects several commits produces a valid aggregate patch, but it does
 * not identify one old/new pair from which to load complete files. In that case this
 * function returns `undefined`, and Hunk shows the patch without expandable gaps. For
 * a merge commit, JJ builds the old side by merging all parent trees. We retain every
 * parent ID to identify that virtual old side, but callers must not substitute one
 * parent and present its contents as the merge baseline.
 */
export function resolveJjDiffEndpoints(
  input: JjBackedInput,
  revset: string,
  options: Omit<RunJjTextOptions, "input" | "args"> = {},
): JjDiffEndpoints | undefined {
  const commitIds = parseJjCommitIds(
    runJjText({
      input,
      args: ["log", "--no-graph", "-r", revset, "-T", JjCommitIdTemplate],
      ...options,
    }),
  );
  if (commitIds.length !== 1) {
    return undefined;
  }

  const commitId = commitIds[0]!;
  const parentCommitIds = parseJjCommitIds(
    runJjText({
      input,
      args: [
        "log",
        "--no-graph",
        "--ignore-working-copy",
        "-r",
        `${commitId}-`,
        "-T",
        JjCommitIdTemplate,
      ],
      ...options,
    }),
  );

  return {
    newCommitId: commitId,
    oldCommitIds: parentCommitIds.sort(),
  };
}

/** Resolve two named JJ revisions to the immutable trees used by diff and source expansion. */
export function resolveJjRangeEndpoints(
  input: ExtensionVcsDiffInput,
  endpoints: ExtensionVcsRangeEndpoints,
  options: Omit<RunJjTextOptions, "input" | "args"> = {},
): JjDiffEndpoints | undefined {
  const from = requireJjRevisionArg(input, endpoints.from);
  const to = requireJjRevisionArg(input, endpoints.to);
  const resolveOne = (revset: string) =>
    parseJjCommitIds(
      runJjText({
        input,
        args: ["log", "--no-graph", "-r", revset, "-T", JjCommitIdTemplate],
        ...options,
      }),
    );
  const fromCommitIds = resolveOne(from);
  const toCommitIds = resolveOne(to);
  if (fromCommitIds.length !== 1 || toCommitIds.length !== 1) {
    return undefined;
  }

  return { newCommitId: toCommitIds[0]!, oldCommitIds: [fromCommitIds[0]!] };
}

/** Resolve immutable JJ endpoints without blocking renderer input. */
export async function resolveJjDiffEndpointsAsync(
  input: JjBackedInput,
  revset: string,
  options: Omit<RunJjTextOptions, "input" | "args"> = {},
): Promise<JjDiffEndpoints | undefined> {
  const commitIds = parseJjCommitIds(
    await runJjTextAsync({
      input,
      args: ["log", "--no-graph", "-r", revset, "-T", JjCommitIdTemplate],
      ...options,
    }),
  );
  if (commitIds.length !== 1) return undefined;
  const commitId = commitIds[0]!;
  const parentCommitIds = parseJjCommitIds(
    await runJjTextAsync({
      input,
      args: [
        "log",
        "--no-graph",
        "--ignore-working-copy",
        "-r",
        `${commitId}-`,
        "-T",
        JjCommitIdTemplate,
      ],
      ...options,
    }),
  );
  return { newCommitId: commitId, oldCommitIds: parentCommitIds.sort() };
}

/** Resolve two immutable JJ range endpoints without blocking renderer input. */
export async function resolveJjRangeEndpointsAsync(
  input: ExtensionVcsDiffInput,
  endpoints: ExtensionVcsRangeEndpoints,
  options: Omit<RunJjTextOptions, "input" | "args"> = {},
): Promise<JjDiffEndpoints | undefined> {
  const from = requireJjRevisionArg(input, endpoints.from);
  const to = requireJjRevisionArg(input, endpoints.to);
  const resolveOne = async (revset: string) =>
    parseJjCommitIds(
      await runJjTextAsync({
        input,
        args: ["log", "--no-graph", "-r", revset, "-T", JjCommitIdTemplate],
        ...options,
      }),
    );
  const fromCommitIds = await resolveOne(from);
  const toCommitIds = await resolveOne(to);
  if (fromCommitIds.length !== 1 || toCommitIds.length !== 1) return undefined;
  return { newCommitId: toCommitIds[0]!, oldCommitIds: [fromCommitIds[0]!] };
}

export function resolveJjRepoRoot(
  input: JjBackedInput,
  options: Omit<RunJjTextOptions, "input" | "args"> = {},
) {
  const repoRoot = runJjText({
    input,
    args: ["root"],
    ...options,
  }).trim();
  return normalizePathForOS(repoRoot);
}

/** Resolve the JJ repository root without blocking renderer input. */
export async function resolveJjRepoRootAsync(
  input: JjBackedInput,
  options: Omit<RunJjTextOptions, "input" | "args"> = {},
) {
  return normalizePathForOS((await runJjTextAsync({ input, args: ["root"], ...options })).trim());
}
