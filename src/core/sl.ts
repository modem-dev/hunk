import fs from "node:fs";
import { join } from "node:path";
import { HunkUserError } from "./errors";
import { isHunkMetadataRelativePath } from "./paths";
import type { VcsDiffCommandInput, VcsShowCommandInput } from "./types";
import { normalizePathForOS } from "../lib/osPath";

export type SlBackedInput = VcsDiffCommandInput | VcsShowCommandInput;

export interface RunSlTextOptions {
  input: SlBackedInput;
  args: string[];
  cwd?: string;
  slExecutable?: string;
}

/** Append Sapling pathspec arguments only when the caller requested path filtering. */
function appendSlPathspecs(args: string[], pathspecs?: string[]) {
  if (!pathspecs || pathspecs.length === 0) {
    return;
  }

  args.push("--", ...pathspecs);
}

/** Build the `sl diff --git` arguments for working-copy and revset reviews. */
export function buildSlDiffArgs(input: VcsDiffCommandInput) {
  const args = ["diff", "--git"];

  if (input.range) {
    args.push("-r", input.range);
  }

  appendSlPathspecs(args, input.pathspecs);
  return args;
}

/** Build the `sl diff --git --change` arguments used for `hunk show` in Sapling mode. */
export function buildSlShowArgs(input: VcsShowCommandInput) {
  const args = ["diff", "--git", "--change", input.ref ?? "."];

  appendSlPathspecs(args, input.pathspecs);
  return args;
}

/** Build the status query used to discover Sapling unknown files for working-copy review. */
function buildSlStatusArgs(input: VcsDiffCommandInput) {
  const args = ["status", "--unknown", "--print0", "--root-relative"];

  appendSlPathspecs(args, input.pathspecs);
  return args;
}

/** Format a user-facing label for the Sapling command being run. */
export function formatSlCommandLabel(input: SlBackedInput) {
  if (input.kind === "vcs") {
    if (input.staged) {
      return "hunk diff --staged";
    }

    return input.range ? `hunk diff ${input.range}` : "hunk diff";
  }

  return input.ref ? `hunk show ${input.ref}` : "hunk show";
}

function trimSlPrefix(message: string) {
  return message.replace(/^(abort|error):\s*/i, "").trim();
}

function firstSlErrorLine(stderr: string) {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);

  return trimSlPrefix((line ?? stderr.trim()) || "Sapling command failed.");
}

function isMissingSlRepoMessage(stderr: string) {
  return ["is not inside a repository", "not in a repository", "no repository found"].some(
    (fragment) => stderr.toLowerCase().includes(fragment.toLowerCase()),
  );
}

function isInvalidRevsetMessage(stderr: string) {
  return [
    "unknown revision",
    "ambiguous identifier",
    "can't find revision",
    "is not a valid revision",
    "revision not found",
    "syntax error in revset",
  ].some((fragment) => stderr.toLowerCase().includes(fragment.toLowerCase()));
}

function createMissingSlExecutableError(input: SlBackedInput, slExecutable: string) {
  return new HunkUserError(
    `Sapling is required for \`${formatSlCommandLabel(input)}\` when \`vcs = "sl"\`, but \`${slExecutable}\` was not found in PATH.`,
    ['Install Sapling or set `vcs = "git"` in Hunk config, then try again.'],
  );
}

function createMissingSlRepoError(input: SlBackedInput) {
  return new HunkUserError(
    `\`${formatSlCommandLabel(input)}\` must be run inside a Sapling repository when \`vcs = "sl"\`.`,
    ['Run the command from a Sapling checkout, or set `vcs = "git"` in Hunk config.'],
  );
}

/** Return the user-facing error when `--staged` is used with Sapling. */
export function createSlStagedError(input: VcsDiffCommandInput) {
  return new HunkUserError(
    `\`${formatSlCommandLabel(input)}\` requires Git VCS mode because Sapling has no staging area.`,
    ['Remove `--staged`, or set `vcs = "git"` in Hunk config.'],
  );
}

function createInvalidRevsetError(input: SlBackedInput) {
  const revset = input.kind === "vcs" ? input.range : (input.ref ?? ".");
  return new HunkUserError(
    `\`${formatSlCommandLabel(input)}\` could not resolve Sapling revset \`${revset}\`.`,
    ["Check the revset and try again."],
  );
}

function createGenericSlError(input: SlBackedInput, stderr: string) {
  return new HunkUserError(`\`${formatSlCommandLabel(input)}\` failed.`, [
    firstSlErrorLine(stderr),
  ]);
}

function translateSlSpawnFailure(
  input: SlBackedInput,
  error: unknown,
  slExecutable: string,
): Error {
  if (error instanceof HunkUserError) {
    return error;
  }

  if (error instanceof Error && error.message.includes("Executable not found in $PATH")) {
    return createMissingSlExecutableError(input, slExecutable);
  }

  return error instanceof Error ? error : new Error(String(error));
}

function translateSlExitFailure(input: SlBackedInput, stderr: string) {
  if (isMissingSlRepoMessage(stderr)) {
    return createMissingSlRepoError(input);
  }

  if (isInvalidRevsetMessage(stderr)) {
    return createInvalidRevsetError(input);
  }

  return createGenericSlError(input, stderr);
}

/** Spawn one Sapling command and accept only declared non-error exit codes. */
function runSlCommand({ input, args, cwd = process.cwd(), slExecutable = "sl" }: RunSlTextOptions) {
  let proc: ReturnType<typeof Bun.spawnSync>;
  const command = [slExecutable, "--noninteractive", "--color", "never", ...args];

  try {
    proc = Bun.spawnSync(command, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw translateSlSpawnFailure(input, error, slExecutable);
  }

  const stdout = Buffer.from(proc.stdout ?? []).toString("utf8");
  const stderr = Buffer.from(proc.stderr ?? []).toString("utf8");

  if (proc.exitCode !== 0) {
    throw translateSlExitFailure(input, stderr.trim() || `Command failed: ${command.join(" ")}`);
  }

  return {
    stdout,
    exitCode: proc.exitCode,
  };
}

/** Run a Sapling command and translate common failures into user-facing Hunk errors. */
export function runSlText(options: RunSlTextOptions) {
  return runSlCommand(options).stdout;
}

/** Return whether working-copy review should synthesize unknown Sapling files into the patch stream. */
function shouldIncludeUntrackedFiles(input: VcsDiffCommandInput) {
  return !input.staged && input.options.excludeUntracked !== true;
}

/** Parse `sl status --unknown --print0` output down to repo-root-relative file paths. */
function parseUntrackedFilePaths(statusText: string) {
  return statusText
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => (entry.startsWith("? ") ? [entry.slice(2)] : []));
}

/** Return whether one untracked path can be synthesized into a file diff. */
function isReviewableUntrackedPath(repoRoot: string, filePath: string) {
  const absolutePath = join(repoRoot, filePath);

  let pathInfo: fs.Stats;
  try {
    pathInfo = fs.lstatSync(absolutePath);
  } catch {
    return true;
  }

  if (pathInfo.isDirectory()) {
    return false;
  }

  if (!pathInfo.isSymbolicLink()) {
    return true;
  }

  try {
    return !fs.statSync(absolutePath).isDirectory();
  } catch {
    return true;
  }
}

/** Return the repo-root-relative unknown files for a working-copy Sapling review. */
export function listSlUntrackedFiles(
  input: VcsDiffCommandInput,
  {
    cwd = process.cwd(),
    repoRoot,
    slExecutable = "sl",
  }: Omit<RunSlTextOptions, "input" | "args"> & { repoRoot?: string } = {},
) {
  if (!shouldIncludeUntrackedFiles(input)) {
    return [];
  }

  const statusText = runSlText({
    input,
    args: buildSlStatusArgs(input),
    cwd,
    slExecutable,
  });

  const untrackedFiles = parseUntrackedFilePaths(statusText);
  if (untrackedFiles.length === 0) {
    return [];
  }

  const normalizedRepoRoot = repoRoot ?? resolveSlRepoRoot(input, { cwd, slExecutable });
  return untrackedFiles.filter(
    (filePath) =>
      // Hunk's own `.hunk/` metadata is review context, never review content.
      !isHunkMetadataRelativePath(filePath) &&
      isReviewableUntrackedPath(normalizedRepoRoot, filePath),
  );
}

/** Resolve the repo root by running `sl root`. */
export function resolveSlRepoRoot(
  input: SlBackedInput,
  options: Omit<RunSlTextOptions, "input" | "args"> = {},
) {
  const repoRoot = runSlText({
    input,
    args: ["root"],
    ...options,
  }).trim();
  return normalizePathForOS(repoRoot);
}
