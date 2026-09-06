/**
 * Reads both index and worktree status and applies explicit file staging actions.
 * The host owns selection, consent and refresh; Git owns path resolution and index locking.
 * Attestations bind pending actions to the status and filesystem state the user reviewed.
 */
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  HunkExtensionUserError,
  type ExtensionVcsDiffInput,
  type ExtensionWorkingTreeFile,
} from "hunkdiff/extension";
import { inspectLargeUntrackedFile } from "@hunk/vcs/large-file";
import {
  appendGitPathspecs,
  buildGitDiffNumstatArgs,
  parseGitNumstat,
  resolveGitRepoRoot,
  runGitMutation,
  runGitText,
  type GitNumstatFile,
} from "./commands";

interface GitWorkingTreeContext {
  cwd: string;
  gitExecutable?: string;
}

/** Reject historical comparisons before any status-dependent mutation can begin. */
function requireWorkingTree(input: ExtensionVcsDiffInput) {
  if (input.range !== undefined || input.rangeEndpoints !== undefined) {
    throw new HunkExtensionUserError(
      "Working-tree actions are unavailable in revision comparisons.",
    );
  }
}

/** Attest a leaf without following symlinks, including the absence of a deleted file. */
function fileStamp(root: string, path: string) {
  try {
    const stat = lstatSync(join(root, path));
    return {
      version: `${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      directory: stat.isDirectory(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: "missing", directory: false };
    throw error;
  }
}

/** Load the status inventory independently of the tab selected by the review. */
export function loadGitWorkingTreeFiles(
  input: ExtensionVcsDiffInput,
  { cwd, gitExecutable = "git" }: GitWorkingTreeContext,
): readonly ExtensionWorkingTreeFile[] | undefined {
  if (input.range !== undefined || input.rangeEndpoints !== undefined) return undefined;
  const root = resolveGitRepoRoot(input, { cwd, gitExecutable });
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  appendGitPathspecs(args, input.pathspecs);
  const records = runGitText({ input, args, cwd, gitExecutable, preventOptionalLocks: true }).split(
    "\0",
  );
  const head = runGitText({
    input,
    args: ["rev-parse", "--revs-only", "HEAD"],
    cwd: root,
    gitExecutable,
    preventOptionalLocks: true,
  }).trim();
  const index = new Map<string, string>();
  for (const record of runGitText({
    input,
    args: ["ls-files", "--stage", "-z"],
    cwd: root,
    gitExecutable,
    preventOptionalLocks: true,
  }).split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const path = record.slice(tab + 1);
    index.set(path, `${index.get(path) ?? ""}${record.slice(0, tab)};`);
  }
  const files: ExtensionWorkingTreeFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const previousPath = /[RC]/.test(status) ? records[++i] : undefined;
    const untracked = status === "??";
    if (untracked && input.options.excludeUntracked) continue;
    const stat = fileStamp(root, path);
    const conflicted = status.includes("U") || status === "AA" || status === "DD";
    files.push({
      path,
      previousPath,
      staged: ![" ", "?", "U"].includes(status[0]!),
      unstaged: status[1] !== " ",
      untracked,
      conflicted,
      statusCode: status,
      unavailableReason: conflicted
        ? "Resolve merge conflicts before staging here."
        : stat.directory || index.get(path)?.startsWith("160000 ")
          ? "Use the submodule or directory's own Git workflow."
          : undefined,
      version: JSON.stringify([
        head,
        status,
        index.get(path),
        previousPath && index.get(previousPath),
        stat.version,
        previousPath && fileStamp(root, previousPath).version,
      ]),
    });
  }
  return files;
}

/** Add one numstat list into a path-keyed running total. */
function addNumstat(
  stats: Map<string, { additions: number; deletions: number }>,
  files: readonly GitNumstatFile[],
) {
  for (const file of files) {
    const current = stats.get(file.path) ?? { additions: 0, deletions: 0 };
    stats.set(file.path, {
      additions: current.additions + file.additions,
      deletions: current.deletions + file.deletions,
    });
  }
}

/** Count text lines, treating a trailing newline as a terminator rather than an extra row. */
function countTextLines(text: string) {
  if (text.length === 0) return 0;
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

/**
 * Count untracked lines for sidebar stats without following symlinks or
 * reading past the large-file cap used for review synthesis.
 */
function countWorkingTreeLines(root: string, path: string) {
  const absolutePath = join(root, path);
  try {
    if (lstatSync(absolutePath).isSymbolicLink()) {
      return countTextLines(readlinkSync(absolutePath));
    }
  } catch {
    return 0;
  }

  const largeFileCheck = inspectLargeUntrackedFile(root, path);
  if (largeFileCheck.shouldSkip) {
    return largeFileCheck.stats?.additions ?? 0;
  }

  try {
    return countTextLines(readFileSync(absolutePath, "utf8"));
  } catch {
    return 0;
  }
}

/**
 * Attach staged plus unstaged line counts to a status inventory.
 * Mutation verification keeps using the status-only load so extra numstat
 * queries do not run on every stage/unstage.
 */
export function attachGitWorkingTreeLineStats(
  files: readonly ExtensionWorkingTreeFile[],
  input: ExtensionVcsDiffInput,
  context: GitWorkingTreeContext,
): ExtensionWorkingTreeFile[] {
  if (files.length === 0) return [];
  const stats = new Map<string, { additions: number; deletions: number }>();
  const query = { cwd: context.cwd, gitExecutable: context.gitExecutable };
  addNumstat(
    stats,
    parseGitNumstat(
      runGitText({
        ...query,
        input,
        args: buildGitDiffNumstatArgs({ ...input, staged: false }),
      }),
    ),
  );
  addNumstat(
    stats,
    parseGitNumstat(
      runGitText({
        ...query,
        input,
        args: buildGitDiffNumstatArgs({ ...input, staged: true }),
      }),
    ),
  );
  const root = resolveGitRepoRoot(input, context);
  return files.map((file) => {
    const fileStats =
      stats.get(file.path) ??
      (file.untracked
        ? { additions: countWorkingTreeLines(root, file.path), deletions: 0 }
        : undefined);
    return fileStats ? { ...file, stats: fileStats } : file;
  });
}

/** Revalidate an exact reviewed path and its source attestation before index writes. */
export function verifyGitWorkingTreeFile(
  input: ExtensionVcsDiffInput,
  file: ExtensionWorkingTreeFile,
  context: GitWorkingTreeContext,
) {
  requireWorkingTree(input);
  for (const path of [file.path, file.previousPath].filter(
    (path): path is string => path !== undefined,
  )) {
    if (
      !path ||
      isAbsolute(path) ||
      path.includes("\0") ||
      path.split("/").some((part) => part === ".." || part === ".") ||
      (process.platform === "win32" && path.includes("\\"))
    ) {
      throw new HunkExtensionUserError(
        "Working-tree actions require an exact repository-relative file path.",
      );
    }
  }
  const root = resolveGitRepoRoot(input, context);
  const current = loadGitWorkingTreeFiles(
    { ...input, pathspecs: undefined },
    { ...context, cwd: root },
  )?.find((candidate) => candidate.path === file.path);
  if (!current || current.version !== file.version || current.previousPath !== file.previousPath) {
    throw new HunkExtensionUserError(
      `${file.path} changed since the review loaded. Refresh and try again.`,
    );
  }
  if (current.unavailableReason) throw new HunkExtensionUserError(current.unavailableReason);
  return { root, file: current };
}

/** Stage the file's current content, or restore only its index entry without changing disk content. */
export async function mutateGitFileStaging(
  input: ExtensionVcsDiffInput,
  expected: ExtensionWorkingTreeFile,
  context: GitWorkingTreeContext,
  staged: boolean,
) {
  const { root, file } = verifyGitWorkingTreeFile(input, expected, context);
  if (staged ? !file.unstaged : !file.staged)
    throw new HunkExtensionUserError("The selected file no longer has changes for this action.");
  const base = { input, cwd: root, gitExecutable: context.gitExecutable };
  if (staged) {
    await runGitMutation({ ...base, args: ["--literal-pathspecs", "add", "--", file.path] });
    return;
  }
  // The former path belongs to the staged rename, not to remaining worktree edits.
  const paths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
  // An empty revision list also covers unborn HEAD without confusing repository errors with it.
  const head = runGitText({ ...base, args: ["rev-parse", "--revs-only", "HEAD"] }).trim();
  await runGitMutation({
    ...base,
    args: head
      ? ["--literal-pathspecs", "restore", "--staged", "--", ...paths]
      : ["--literal-pathspecs", "rm", "--cached", "--force", "--", ...paths],
  });
}
