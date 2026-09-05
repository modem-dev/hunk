/**
 * Discards or stashes one confirmed file without including unrelated work.
 * The host owns prompts and refresh. Git owns restore semantics and stash objects;
 * an isolated stash index excludes unrelated staged entries from both stash trees.
 */
import { existsSync, lstatSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HunkExtensionUserError,
  type ExtensionVcsDiffInput,
  type ExtensionVcsDiscardScope,
  type ExtensionWorkingTreeFile,
} from "hunkdiff/extension";
import { runGitBytes, runGitMutation, runGitText } from "./commands";
import { verifyGitWorkingTreeFile } from "./workingTree";

type GitFileActionContext = { cwd: string; gitExecutable?: string };

/** Refuse a recreated rename source rather than restoring over a separate untracked file. */
function requireUnoccupiedRenameSource(root: string, file: ExtensionWorkingTreeFile) {
  if (!file.previousPath) return;
  try {
    lstatSync(join(root, file.previousPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new HunkExtensionUserError(
    `Move the recreated ${file.previousPath} out of the way before acting on this rename.`,
  );
}

/** Discard the exact attested path, retaining staged content for an unstaged-only choice. */
export async function discardGitFile(
  input: ExtensionVcsDiffInput,
  expected: ExtensionWorkingTreeFile,
  scope: ExtensionVcsDiscardScope,
  context: GitFileActionContext,
) {
  const { root, file } = verifyGitWorkingTreeFile(input, expected, context);
  const base = { input, cwd: root, gitExecutable: context.gitExecutable };
  if (scope === "unstaged") {
    if (!file.staged || !file.unstaged)
      throw new HunkExtensionUserError(
        "Unstaged-only discard requires both staged and unstaged changes.",
      );
    await runGitMutation({
      ...base,
      args: ["--literal-pathspecs", "restore", "--worktree", "--", file.path],
    });
    return;
  }
  requireUnoccupiedRenameSource(root, file);
  if (file.untracked) {
    unlinkSync(join(root, file.path));
    return;
  }
  const paths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
  const head = runGitText({ ...base, args: ["rev-parse", "--revs-only", "HEAD"] }).trim();
  if (head) {
    await runGitMutation({
      ...base,
      args: [
        "--literal-pathspecs",
        "restore",
        `--source=${head}`,
        "--staged",
        "--worktree",
        "--",
        ...paths,
      ],
    });
    return;
  }
  // Unborn repositories have no source tree. Remove the index entry before deleting its leaf.
  await runGitMutation({
    ...base,
    args: ["--literal-pathspecs", "rm", "--cached", "--force", "--", ...paths],
  });
  try {
    unlinkSync(join(root, file.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Build a file-only stash before cleaning any live content, retaining it if cleanup fails. */
export async function stashGitFile(
  input: ExtensionVcsDiffInput,
  expected: ExtensionWorkingTreeFile,
  message: string,
  context: GitFileActionContext,
) {
  const { root, file } = verifyGitWorkingTreeFile(input, expected, context);
  requireUnoccupiedRenameSource(root, file);
  const base = { input, cwd: root, gitExecutable: context.gitExecutable };
  const head = runGitText({ ...base, args: ["rev-parse", "--revs-only", "HEAD"] }).trim();
  if (!head) throw new HunkExtensionUserError("Create the first commit before stashing a file.");
  const indexPath = resolve(
    root,
    runGitText({ ...base, args: ["rev-parse", "--git-path", "index"] }).trim(),
  );
  if (existsSync(`${indexPath}.lock`))
    throw new HunkExtensionUserError(
      "Git's index is locked. Finish the other Git operation and try again.",
    );
  const paths = [file.path, ...(file.previousPath ? [file.previousPath] : [])];
  const entries = runGitBytes({
    ...base,
    args: ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...paths],
  });
  const temporary = mkdtempSync(join(tmpdir(), "hunk-file-stash-"));
  const env = { GIT_INDEX_FILE: join(temporary, "index") };
  const label = message || `Hunk: ${file.path}`;
  try {
    await runGitMutation({ ...base, env, args: ["read-tree", head] });
    const removals = Buffer.from(
      paths.map((path) => `0 ${"0".repeat(head.length)}\t${path}\0`).join(""),
    );
    await runGitMutation({
      ...base,
      env,
      args: ["update-index", "-z", "--index-info"],
      stdin: Buffer.concat([removals, entries]),
    });
    const indexTree = (await runGitMutation({ ...base, env, args: ["write-tree"] })).trim();
    const indexCommit = (
      await runGitMutation({
        ...base,
        args: ["commit-tree", indexTree, "-p", head],
        stdin: `index: ${label}\n`,
      })
    ).trim();
    let untrackedCommit: string | undefined;
    if (file.untracked) {
      await runGitMutation({ ...base, env, args: ["read-tree", "--empty"] });
      await runGitMutation({ ...base, env, args: ["--literal-pathspecs", "add", "--", file.path] });
      const untrackedTree = (await runGitMutation({ ...base, env, args: ["write-tree"] })).trim();
      untrackedCommit = (
        await runGitMutation({
          ...base,
          args: ["commit-tree", untrackedTree],
          stdin: `untracked: ${label}\n`,
        })
      ).trim();
      await runGitMutation({ ...base, env, args: ["read-tree", indexTree] });
    } else {
      // Preserve tracked type/mode, including emulated symlinks and ignored executable changes.
      const presentPaths = paths.filter((path) => {
        try {
          lstatSync(join(root, path));
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      });
      const absentPaths = paths.filter((path) => !presentPaths.includes(path));
      if (absentPaths.length)
        await runGitMutation({
          ...base,
          env,
          args: ["update-index", "--force-remove", "--", ...absentPaths],
        });
      if (presentPaths.length)
        await runGitMutation({
          ...base,
          env,
          args: ["--literal-pathspecs", "add", "--force", "--", ...presentPaths],
        });
    }
    const worktreeTree = (await runGitMutation({ ...base, env, args: ["write-tree"] })).trim();
    // Git stash expects HEAD, index, and optional untracked parents in precisely this order.
    const stash = (
      await runGitMutation({
        ...base,
        args: [
          "commit-tree",
          worktreeTree,
          "-p",
          head,
          "-p",
          indexCommit,
          ...(untrackedCommit ? ["-p", untrackedCommit] : []),
        ],
        stdin: `${label}\n`,
      })
    ).trim();
    verifyGitWorkingTreeFile(input, expected, context);
    await runGitMutation({ ...base, args: ["stash", "store", "-m", label, stash] });
    try {
      // Object creation and publication do not consent to overwriting later external edits.
      verifyGitWorkingTreeFile(input, expected, context);
      if (file.untracked) unlinkSync(join(root, file.path));
      else
        await runGitMutation({
          ...base,
          args: [
            "--literal-pathspecs",
            "restore",
            `--source=${head}`,
            "--staged",
            "--worktree",
            "--",
            ...paths,
          ],
        });
    } catch (error) {
      throw new HunkExtensionUserError(
        `Stash ${stash.slice(0, 12)} was created, but ${file.path} could not be cleaned: ${error instanceof Error ? error.message : String(error)}. The stash is retained; inspect Git status before retrying.`,
      );
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
