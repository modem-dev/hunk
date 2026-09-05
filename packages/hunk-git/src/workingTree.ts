/**
 * Reads both index and worktree status and applies explicit file staging actions.
 * The host owns selection, consent and refresh; Git owns path resolution and index locking.
 * Attestations bind pending actions to the status and filesystem state the user reviewed.
 */
import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  HunkExtensionUserError,
  type ExtensionVcsDiffInput,
  type ExtensionWorkingTreeFile,
} from "hunkdiff/extension";
import { appendGitPathspecs, resolveGitRepoRoot, runGitMutation, runGitText } from "./commands";

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
      unavailableReason: conflicted
        ? "Resolve merge conflicts before staging here."
        : stat.directory || index.get(path)?.startsWith("160000 ")
          ? "Use the submodule or directory's own Git workflow."
          : undefined,
      version: JSON.stringify([
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
