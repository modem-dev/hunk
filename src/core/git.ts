import fs from "node:fs";
import { join } from "node:path";
import { HunkUserError } from "./errors";
import { escapeUntrackedPatchPath } from "./patch/normalize";
import type { VcsCommandInput, ShowCommandInput, StashShowCommandInput } from "./types";

export type GitBackedInput = VcsCommandInput | ShowCommandInput | StashShowCommandInput;

export interface RunGitTextOptions {
  input: GitBackedInput;
  args: string[];
  cwd?: string;
  gitExecutable?: string;
}

interface RunGitCommandResult {
  stderr: string;
  stdout: string;
  exitCode: number;
}

interface RunGitCommandOptions extends RunGitTextOptions {
  acceptedExitCodes?: number[];
}

export interface GitColorMovedOptions {
  mode: string;
  whitespaceMode?: string;
}

/** Append Git pathspec arguments only when the caller requested them. */
export function appendGitPathspecs(args: string[], pathspecs?: string[]) {
  if (!pathspecs || pathspecs.length === 0) {
    return;
  }

  args.push("--", ...pathspecs);
}

// @pierre/diffs currently assumes git-style a/ and b/ prefixes when parsing patch headers.
// Force canonical prefixes for git-backed review commands so user/repo git diff config
// (noprefix, mnemonicPrefix, custom src/dst prefixes) cannot break parsing.
const DIFF_PREFIX_NORMALIZATION_ARGS = [
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
];

const GIT_MOVED_LINE_COLOR_CONFIG = [
  "-c",
  "color.diff.oldMoved=magenta bold",
  "-c",
  "color.diff.oldMovedAlternative=magenta bold",
  "-c",
  "color.diff.oldMovedDimmed=magenta dim",
  "-c",
  "color.diff.oldMovedAlternativeDimmed=magenta dim",
  "-c",
  "color.diff.newMoved=cyan bold",
  "-c",
  "color.diff.newMovedAlternative=cyan bold",
  "-c",
  "color.diff.newMovedDimmed=cyan dim",
  "-c",
  "color.diff.newMovedAlternativeDimmed=cyan dim",
];

function withNormalizedDiffPrefixes(args: string[]) {
  return [...DIFF_PREFIX_NORMALIZATION_ARGS, ...args];
}

/** Return Git color flags for patch commands, enabling ANSI only when Hunk needs move classes. */
function gitPatchColorArgs(colorMoved: GitColorMovedOptions | null) {
  if (!colorMoved) {
    return ["--no-color"];
  }

  return [
    "--color=always",
    `--color-moved=${colorMoved.mode}`,
    ...(colorMoved.whitespaceMode ? [`--color-moved-ws=${colorMoved.whitespaceMode}`] : []),
  ];
}

/** Add deterministic moved-line colors so the parser can classify Git's ANSI output reliably. */
function withGitMovedLineColorConfig(args: string[], colorMoved: GitColorMovedOptions | null) {
  if (!colorMoved) {
    return args;
  }

  return [...GIT_MOVED_LINE_COLOR_CONFIG, ...args];
}

/** Build the exact `git diff` arguments used for the shared working-tree and range review path. */
export function buildGitDiffArgs(
  input: VcsCommandInput,
  excludedPathspecs: string[] = [],
  colorMoved: GitColorMovedOptions | null = null,
) {
  const args = ["diff", "--no-ext-diff", "--find-renames", ...gitPatchColorArgs(colorMoved)];

  if (input.staged) {
    args.push("--staged");
  }

  if (input.range) {
    args.push(input.range);
  }

  if (excludedPathspecs.length > 0) {
    args.push(
      "--",
      ...(input.pathspecs ?? []),
      ...excludedPathspecs.map((path) => `:(exclude)${path}`),
    );
  } else {
    appendGitPathspecs(args, input.pathspecs);
  }

  return withNormalizedDiffPrefixes(withGitMovedLineColorConfig(args, colorMoved));
}

/** Build the cheap tracked-file stats query used to skip huge file diffs before patch output. */
export function buildGitDiffNumstatArgs(input: VcsCommandInput) {
  const args = ["diff", "--no-ext-diff", "--find-renames", "--no-color", "--numstat", "-z"];

  if (input.staged) {
    args.push("--staged");
  }

  if (input.range) {
    args.push(input.range);
  }

  appendGitPathspecs(args, input.pathspecs);
  return withNormalizedDiffPrefixes(args);
}

/** Build the porcelain status query used to discover untracked files for working-tree review. */
export function buildGitStatusArgs(input: VcsCommandInput) {
  const args = ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"];

  appendGitPathspecs(args, input.pathspecs);
  return args;
}

/** Build the synthetic patch used to render one untracked file as a new-file diff. */
function buildGitNewFileDiffArgs(filePath: string) {
  // `--no-ext-diff` keeps user-configured `diff.external` tools (difftastic, delta, etc.)
  // from replacing the unified-diff output Pierre needs to parse this synthetic patch.
  return withNormalizedDiffPrefixes([
    "diff",
    "--no-ext-diff",
    "--no-index",
    "--no-color",
    "--",
    "/dev/null",
    filePath,
  ]);
}

/** Build the exact `git show` arguments used for commit review. */
export function buildGitShowArgs(
  input: ShowCommandInput,
  colorMoved: GitColorMovedOptions | null = null,
) {
  const args = [
    "show",
    "--format=",
    "--no-ext-diff",
    "--find-renames",
    ...gitPatchColorArgs(colorMoved),
  ];

  if (input.ref) {
    args.push(input.ref);
  }

  appendGitPathspecs(args, input.pathspecs);
  return withNormalizedDiffPrefixes(withGitMovedLineColorConfig(args, colorMoved));
}

/** Build the exact `git stash show -p` arguments used for stash review. */
export function buildGitStashShowArgs(
  input: StashShowCommandInput,
  colorMoved: GitColorMovedOptions | null = null,
) {
  const args = [
    "stash",
    "show",
    "-p",
    "--no-ext-diff",
    "--find-renames",
    ...gitPatchColorArgs(colorMoved),
  ];

  if (input.ref) {
    args.push(input.ref);
  }

  return withNormalizedDiffPrefixes(withGitMovedLineColorConfig(args, colorMoved));
}

export function formatGitCommandLabel(input: GitBackedInput) {
  switch (input.kind) {
    case "vcs":
      if (input.staged) {
        return "hunk diff --staged";
      }

      return input.range ? `hunk diff ${input.range}` : "hunk diff";
    case "show":
      return input.ref ? `hunk show ${input.ref}` : "hunk show";
    case "stash-show":
      return input.ref ? `hunk stash show ${input.ref}` : "hunk stash show";
  }
}

function getMissingRepoHelp(input: GitBackedInput) {
  if (input.kind === "vcs") {
    return [
      "Run the command from a Git checkout, or compare files directly instead:",
      "  hunk diff <before-file> <after-file>",
      "  hunk patch <file.patch>",
    ];
  }

  return ["Run the command from a Git checkout."];
}

function trimGitPrefix(message: string) {
  return message.replace(/^(fatal|error):\s*/i, "").trim();
}

function firstGitErrorLine(stderr: string) {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);

  return trimGitPrefix((line ?? stderr.trim()) || "Git command failed.");
}

function isMissingGitRepoMessage(stderr: string) {
  return stderr.includes("not a git repository");
}

function isUnknownRevisionMessage(stderr: string) {
  return [
    "bad revision",
    "unknown revision or path not in the working tree",
    "ambiguous argument",
    "Needed a single revision",
  ].some((fragment) => stderr.includes(fragment));
}

function isNoStashEntriesMessage(stderr: string) {
  return ["No stash entries found.", "log for 'stash' only has"].some((fragment) =>
    stderr.includes(fragment),
  );
}

function createMissingGitExecutableError(input: GitBackedInput, gitExecutable: string) {
  return new HunkUserError(
    `Git is required for \`${formatGitCommandLabel(input)}\`, but \`${gitExecutable}\` was not found in PATH.`,
    ["Install Git or make it available on PATH, then try again."],
  );
}

function createMissingRepoError(input: GitBackedInput) {
  return new HunkUserError(
    `\`${formatGitCommandLabel(input)}\` must be run inside a Git repository.`,
    getMissingRepoHelp(input),
  );
}

function createInvalidRevisionError(input: VcsCommandInput | ShowCommandInput) {
  if (input.kind === "vcs") {
    return new HunkUserError(
      `\`${formatGitCommandLabel(input)}\` could not resolve Git revision or range \`${input.range}\`.`,
      ["Check the revision or range and try again."],
    );
  }

  const ref = input.ref ?? "HEAD";
  return new HunkUserError(
    `\`${formatGitCommandLabel(input)}\` could not resolve Git ref \`${ref}\`.`,
    ["Check the ref name and try again."],
  );
}

function createMissingStashError(input: StashShowCommandInput) {
  if (input.ref) {
    return new HunkUserError(
      `\`${formatGitCommandLabel(input)}\` could not resolve stash entry \`${input.ref}\`.`,
      ["List available stashes with `git stash list`, then try again."],
    );
  }

  return new HunkUserError("`hunk stash show` could not find a stash entry to show.", [
    "Create one with `git stash push`, or pass an explicit stash ref like `hunk stash show stash@{0}`.",
  ]);
}

function createGenericGitError(input: GitBackedInput, stderr: string) {
  return new HunkUserError(`\`${formatGitCommandLabel(input)}\` failed.`, [
    firstGitErrorLine(stderr),
  ]);
}

function translateGitSpawnFailure(
  input: GitBackedInput,
  error: unknown,
  gitExecutable: string,
): Error {
  if (error instanceof HunkUserError) {
    return error;
  }

  if (error instanceof Error && error.message.includes("Executable not found in $PATH")) {
    return createMissingGitExecutableError(input, gitExecutable);
  }

  return error instanceof Error ? error : new Error(String(error));
}

function translateGitExitFailure(input: GitBackedInput, stderr: string) {
  if (isMissingGitRepoMessage(stderr)) {
    return createMissingRepoError(input);
  }

  if (
    input.kind === "stash-show" &&
    (isNoStashEntriesMessage(stderr) || isUnknownRevisionMessage(stderr))
  ) {
    return createMissingStashError(input);
  }

  if (input.kind === "vcs" && input.range && isUnknownRevisionMessage(stderr)) {
    return createInvalidRevisionError(input);
  }

  if (input.kind === "show" && isUnknownRevisionMessage(stderr)) {
    return createInvalidRevisionError(input);
  }

  if (input.kind === "stash-show" && input.ref && isUnknownRevisionMessage(stderr)) {
    return createMissingStashError(input);
  }

  return createGenericGitError(input, stderr);
}

/** Spawn one Git command and accept only the exit codes the caller declared as non-errors. */
function runGitCommand({
  input,
  args,
  cwd = process.cwd(),
  gitExecutable = "git",
  acceptedExitCodes = [0],
}: RunGitCommandOptions): RunGitCommandResult {
  let proc: ReturnType<typeof Bun.spawnSync>;

  try {
    proc = Bun.spawnSync([gitExecutable, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw translateGitSpawnFailure(input, error, gitExecutable);
  }

  const stdout = Buffer.from(proc.stdout ?? []).toString("utf8");
  const stderr = Buffer.from(proc.stderr ?? []).toString("utf8");

  if (!acceptedExitCodes.includes(proc.exitCode)) {
    throw translateGitExitFailure(
      input,
      stderr.trim() || `Command failed: ${gitExecutable} ${args.join(" ")}`,
    );
  }

  return {
    stderr,
    stdout,
    exitCode: proc.exitCode,
  };
}

/** Run a git command and translate common failures into user-facing Hunk errors. */
export function runGitText(options: RunGitTextOptions) {
  return runGitCommand(options).stdout;
}

const GIT_BOOLEAN_TRUE_VALUES = new Set(["true", "yes", "on", "1", "always"]);
const GIT_BOOLEAN_FALSE_VALUES = new Set(["false", "no", "off", "0", "never"]);

/** Read an optional Git config value without treating an unset key as an error. */
function readOptionalGitConfig(
  input: GitBackedInput,
  key: string,
  options: Omit<RunGitTextOptions, "input" | "args"> = {},
) {
  const result = runGitCommand({
    input,
    args: ["config", "--get", key],
    ...options,
    acceptedExitCodes: [0, 1],
  });

  if (result.exitCode !== 0) {
    return undefined;
  }

  return result.stdout.trim() || undefined;
}

/** Normalize Git's diff.colorMoved config into the mode Hunk should request from Git. */
function normalizeGitColorMovedMode(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase();
  if (GIT_BOOLEAN_FALSE_VALUES.has(normalized) || normalized === "no") {
    return null;
  }

  if (GIT_BOOLEAN_TRUE_VALUES.has(normalized)) {
    return "zebra";
  }

  return value;
}

/** Resolve whether Hunk should ask Git to color moved lines for this patch command. */
export function resolveGitColorMovedOptions(
  input: GitBackedInput,
  options: Omit<RunGitTextOptions, "input" | "args"> = {},
): GitColorMovedOptions | null {
  const gitMode = normalizeGitColorMovedMode(
    readOptionalGitConfig(input, "diff.colorMoved", options),
  );

  if (gitMode === null) {
    return null;
  }

  const mode = gitMode ?? (input.options.colorMoved ? "zebra" : undefined);
  if (!mode) {
    return null;
  }

  const whitespaceMode = readOptionalGitConfig(input, "diff.colorMovedWS", options);
  return {
    mode,
    whitespaceMode,
  };
}

/**
 * Return whether one `hunk diff` input still compares against the live working tree.
 *
 * Plain `hunk diff <ref>` keeps the working tree on one side, so untracked files should still
 * appear. Explicit revision-set expressions like `a..b`, `a...b`, or `rev^!` expand into positive
 * and negative revisions and should stay commit-to-commit only.
 */
const workingTreeGitDiffInputCache = new Map<string, boolean>();

function isWorkingTreeGitDiffInput(
  input: VcsCommandInput,
  {
    cwd = process.cwd(),
    gitExecutable = "git",
    repoRoot,
  }: Pick<RunGitTextOptions, "cwd" | "gitExecutable"> & { repoRoot?: string } = {},
) {
  if (input.staged) {
    return false;
  }

  if (!input.range) {
    return true;
  }

  const cacheKey = `${gitExecutable}\0${repoRoot ?? cwd}\0${input.range}`;
  const cached = workingTreeGitDiffInputCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const revs = runGitText({
    input,
    args: ["rev-parse", "--revs-only", input.range],
    cwd,
    gitExecutable,
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const positiveRevs = revs.filter((line) => !line.startsWith("^"));
  const negativeRevs = revs.filter((line) => line.startsWith("^"));
  const includesWorkingTree = positiveRevs.length === 1 && negativeRevs.length === 0;

  workingTreeGitDiffInputCache.set(cacheKey, includesWorkingTree);
  return includesWorkingTree;
}

/** Return whether working-tree review should synthesize untracked files into the patch stream. */
function shouldIncludeUntrackedFiles(
  input: VcsCommandInput,
  options: Pick<RunGitTextOptions, "cwd" | "gitExecutable"> & { repoRoot?: string } = {},
) {
  return input.options.excludeUntracked !== true && isWorkingTreeGitDiffInput(input, options);
}

/** Parse porcelain status output down to repo-root-relative untracked file paths. */
function parseUntrackedFilePaths(statusText: string) {
  return statusText
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => (entry.startsWith("?? ") ? [entry.slice(3)] : []));
}

/** Return whether one untracked path can be synthesized into a file diff. */
function isReviewableUntrackedPath(repoRoot: string, filePath: string) {
  const absolutePath = join(repoRoot, filePath);

  let pathInfo: fs.Stats;
  try {
    pathInfo = fs.lstatSync(absolutePath);
  } catch {
    // If the path disappeared after `git status`, let the downstream Git diff
    // surface the same error path users would have seen before this filter.
    return true;
  }

  if (pathInfo.isDirectory()) {
    return false;
  }

  if (!pathInfo.isSymbolicLink()) {
    return true;
  }

  try {
    // Git reports directory symlinks as untracked paths, but `git diff --no-index`
    // cannot synthesize a parseable file patch for them.
    return !fs.statSync(absolutePath).isDirectory();
  } catch {
    // Broken symlinks still diff as reviewable path entries, so keep them.
    return true;
  }
}

/** Return the repo-root-relative untracked files for a working-tree review input. */
export function listGitUntrackedFiles(
  input: VcsCommandInput,
  {
    cwd = process.cwd(),
    repoRoot,
    gitExecutable = "git",
  }: Omit<RunGitTextOptions, "input" | "args"> & { repoRoot?: string } = {},
) {
  if (!shouldIncludeUntrackedFiles(input, { cwd, gitExecutable })) {
    return [];
  }

  const statusText = runGitText({
    input,
    args: buildGitStatusArgs(input),
    cwd,
    gitExecutable,
  });

  const untrackedFiles = parseUntrackedFilePaths(statusText);
  if (untrackedFiles.length === 0) {
    return [];
  }

  const normalizedRepoRoot = repoRoot ?? resolveGitRepoRoot(input, { cwd, gitExecutable });
  return untrackedFiles.filter((filePath) =>
    isReviewableUntrackedPath(normalizedRepoRoot, filePath),
  );
}

/** Rewrite Git's quoted untracked-file headers into parser-friendly paths. */
export function normalizeUntrackedPatchHeaders(patchText: string, filePath: string) {
  const safePath = escapeUntrackedPatchPath(filePath);

  return patchText
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        return `diff --git a/${safePath} b/${safePath}`;
      }

      if (line.startsWith("+++ ")) {
        return `+++ b/${safePath}`;
      }

      if (line.startsWith("Binary files /dev/null and ")) {
        return `Binary files /dev/null and b/${safePath} differ`;
      }

      return line;
    })
    .join("\n");
}

/** Return the raw Git patch text for one untracked file using `git diff --no-index`. */
export function runGitUntrackedFileDiffText(
  input: VcsCommandInput,
  filePath: string,
  {
    cwd = process.cwd(),
    repoRoot,
    gitExecutable = "git",
  }: Omit<RunGitTextOptions, "input" | "args"> & { repoRoot?: string } = {},
) {
  const normalizedRepoRoot = repoRoot ?? resolveGitRepoRoot(input, { cwd, gitExecutable });

  return runGitCommand({
    input,
    args: buildGitNewFileDiffArgs(filePath),
    cwd: normalizedRepoRoot,
    gitExecutable,
    acceptedExitCodes: [0, 1],
  }).stdout;
}

export function resolveGitRepoRoot(
  input: GitBackedInput,
  options: Omit<RunGitTextOptions, "input" | "args"> = {},
) {
  return runGitText({
    input,
    args: ["rev-parse", "--show-toplevel"],
    ...options,
  }).trim();
}

/** Resolve one commit-ish ref to the exact commit object used for later blob reads. */
export function resolveGitCommitRef(
  input: GitBackedInput,
  ref: string,
  options: Omit<RunGitTextOptions, "input" | "args"> = {},
) {
  return runGitText({
    input,
    args: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    ...options,
  })
    .split("\n")[0]!
    .trim();
}

/** Resolve a commit-ish ref, returning null when that ref does not exist. */
function tryResolveGitCommitRef(
  input: GitBackedInput,
  ref: string,
  options: Omit<RunGitTextOptions, "input" | "args"> = {},
) {
  const result = runGitCommand({
    input,
    args: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    ...options,
    acceptedExitCodes: [0, 1, 128],
  });

  if (result.exitCode === 0) {
    return result.stdout.split("\n")[0]!.trim();
  }

  if (isUnknownRevisionMessage(result.stderr)) {
    return null;
  }

  throw translateGitExitFailure(input, result.stderr.trim() || `Could not resolve Git ref ${ref}.`);
}

export type GitDiffEndpoint =
  | { kind: "none" }
  | { kind: "git-ref"; ref: string }
  | { kind: "index" }
  | { kind: "worktree" };

/** Endpoints describing what each diff side compares for one VCS diff input. */
export interface GitDiffEndpoints {
  old: GitDiffEndpoint;
  new: GitDiffEndpoint;
}

/** Parse "A...B" into its two refs, defaulting empty sides to HEAD as Git does. */
function parseSymmetricDiffRange(range: string): { left: string; right: string } | null {
  // Runs of four or more dots are not a valid range; bail rather than
  // silently treating the first three as a symmetric-diff separator.
  if (/\.{4,}/.test(range)) {
    return null;
  }

  const parts = range.split("...");
  if (parts.length !== 2) {
    return null;
  }

  return { left: parts[0] || "HEAD", right: parts[1] || "HEAD" };
}

/** Resolve rev-parse output into positive and negative revisions for one diff range. */
function resolveRangeRevisions(
  input: VcsCommandInput,
  range: string,
  {
    cwd = process.cwd(),
    gitExecutable = "git",
    repoRoot,
  }: Omit<RunGitTextOptions, "input" | "args"> & { repoRoot?: string } = {},
): { positives: string[]; negatives: string[] } {
  const revs = runGitText({
    input,
    args: ["rev-parse", "--revs-only", range],
    cwd: repoRoot ?? cwd,
    gitExecutable,
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    positives: revs.filter((rev) => !rev.startsWith("^")),
    negatives: revs.filter((rev) => rev.startsWith("^")).map((rev) => rev.slice(1)),
  };
}

/**
 * Resolve the old/new endpoints implied by a `hunk diff` invocation.
 *
 * Returns `null` when the range maps to a shape we cannot represent as a
 * single old/new pair. Callers should treat that as "do not attempt to read
 * source by ref" rather than silently falling back to the working tree.
 */
export function resolveGitDiffEndpoints(
  input: VcsCommandInput,
  {
    cwd = process.cwd(),
    gitExecutable = "git",
    repoRoot,
  }: Omit<RunGitTextOptions, "input" | "args"> & { repoRoot?: string } = {},
): GitDiffEndpoints | null {
  if (input.staged) {
    if (!input.range) {
      const headRef = tryResolveGitCommitRef(input, "HEAD", {
        cwd: repoRoot ?? cwd,
        gitExecutable,
      });

      return {
        old: headRef ? { kind: "git-ref", ref: headRef } : { kind: "none" },
        new: { kind: "index" },
      };
    }

    const { positives, negatives } = resolveRangeRevisions(input, input.range, {
      cwd,
      gitExecutable,
      repoRoot,
    });

    if (positives.length === 1 && negatives.length === 0) {
      return { old: { kind: "git-ref", ref: positives[0]! }, new: { kind: "index" } };
    }

    return null;
  }

  if (!input.range) {
    return { old: { kind: "index" }, new: { kind: "worktree" } };
  }

  // `git diff A...B` compares merge-base(A, B) against B, not HEAD or the
  // working tree. Resolve the merge base explicitly so expanded source rows
  // read from the same revisions the diff was computed from.
  const symmetric = parseSymmetricDiffRange(input.range);
  if (symmetric) {
    const mergeBase = runGitText({
      input,
      args: ["merge-base", symmetric.left, symmetric.right],
      cwd: repoRoot ?? cwd,
      gitExecutable,
    })
      .split("\n")[0]
      ?.trim();
    if (!mergeBase) {
      return null;
    }

    const rightRef = resolveGitCommitRef(input, symmetric.right, {
      cwd: repoRoot ?? cwd,
      gitExecutable,
    });

    return {
      old: { kind: "git-ref", ref: mergeBase },
      new: { kind: "git-ref", ref: rightRef },
    };
  }

  // Real rev-parse failures (bogus refs, missing repo) propagate to the caller
  // so the user sees a clear error instead of a silent working-tree fallback.
  const { positives, negatives } = resolveRangeRevisions(input, input.range, {
    cwd,
    gitExecutable,
    repoRoot,
  });

  if (positives.length === 1 && negatives.length === 0) {
    // Single revision diffs against the working tree.
    return { old: { kind: "git-ref", ref: positives[0]! }, new: { kind: "worktree" } };
  }

  if (positives.length === 1 && negatives.length === 1) {
    return {
      old: { kind: "git-ref", ref: negatives[0]! },
      new: { kind: "git-ref", ref: positives[0]! },
    };
  }

  // Multi-revision ranges that succeeded rev-parse but don't fit a simple
  // old/new pair (octopus merges, multi-positive sets) have no safe mapping.
  // Returning null disables source-by-ref reads so we never render source
  // from the wrong revision.
  return null;
}
