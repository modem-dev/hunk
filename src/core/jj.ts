import { HunkUserError } from "./errors";
import type { VcsCommandInput, ShowCommandInput } from "./types";

export type JjBackedInput = VcsCommandInput | ShowCommandInput;

export interface RunJjTextOptions {
  input: JjBackedInput;
  args: string[];
  cwd?: string;
  jjExecutable?: string;
}

/** Append Jujutsu filesets only when the caller requested path filtering. */
function appendJjFilesets(args: string[], pathspecs?: string[]) {
  if (!pathspecs || pathspecs.length === 0) {
    return;
  }

  args.push("--", ...pathspecs);
}

/** Build the `jj diff --git` arguments for working-copy and revset reviews. */
export function buildJjDiffArgs(input: VcsCommandInput) {
  const args = ["diff", "--git"];

  if (input.range) {
    args.push("-r", input.range);
  }

  appendJjFilesets(args, input.pathspecs);
  return args;
}

/** Build the `jj diff --git -r` arguments used for `hunk show` in Jujutsu mode. */
export function buildJjShowArgs(input: ShowCommandInput) {
  const args = ["diff", "--git", "-r", input.ref ?? "@"];

  appendJjFilesets(args, input.pathspecs);
  return args;
}

export function formatJjCommandLabel(input: JjBackedInput) {
  if (input.kind === "vcs") {
    if (input.staged) {
      return "hunk diff --staged";
    }

    return input.range ? `hunk diff ${input.range}` : "hunk diff";
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
  return new HunkUserError(
    `Jujutsu is required for \`${formatJjCommandLabel(input)}\` when \`vcs = "jj"\`, but \`${jjExecutable}\` was not found in PATH.`,
    ['Install Jujutsu or set `vcs = "git"` in Hunk config, then try again.'],
  );
}

function createMissingJjRepoError(input: JjBackedInput) {
  return new HunkUserError(
    `\`${formatJjCommandLabel(input)}\` must be run inside a Jujutsu repository when \`vcs = "jj"\`.`,
    ['Run the command from a Jujutsu checkout, or set `vcs = "git"` in Hunk config.'],
  );
}

export function createJjStagedError(input: VcsCommandInput) {
  return new HunkUserError(
    `\`${formatJjCommandLabel(input)}\` requires Git VCS mode because Jujutsu has no staging area.`,
    ['Remove `--staged`, or set `vcs = "git"` in Hunk config.'],
  );
}

function createInvalidRevsetError(input: JjBackedInput) {
  const revset = input.kind === "vcs" ? input.range : (input.ref ?? "@");
  return new HunkUserError(
    `\`${formatJjCommandLabel(input)}\` could not resolve Jujutsu revset \`${revset}\`.`,
    ["Check the revset and try again."],
  );
}

function createGenericJjError(input: JjBackedInput, stderr: string) {
  return new HunkUserError(`\`${formatJjCommandLabel(input)}\` failed.`, [
    firstJjErrorLine(stderr),
  ]);
}

function translateJjSpawnFailure(
  input: JjBackedInput,
  error: unknown,
  jjExecutable: string,
): Error {
  if (error instanceof HunkUserError) {
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

export function resolveJjRepoRoot(
  input: JjBackedInput,
  options: Omit<RunJjTextOptions, "input" | "args"> = {},
) {
  return runJjText({
    input,
    args: ["root"],
    ...options,
  }).trim();
}
