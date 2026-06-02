import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HunkUserError } from "../errors";
import {
  buildSlDiffArgs,
  buildSlShowArgs,
  createSlStagedError,
  listSlUntrackedFiles,
  resolveSlRepoRoot,
  runSlText,
} from "../sl";
import type { VcsAdapter } from "./types";

/** Return the last path segment for review titles. */
function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Return whether a `.hg` directory belongs to Sapling rather than upstream Mercurial. */
function isSaplingHgRepo(hgDir: string) {
  try {
    return fs.readFileSync(join(hgDir, "requires"), "utf8").split("\n").includes("treestate");
  } catch {
    return false;
  }
}

/** Walk upward to detect a Sapling workspace marker. `.sl` always matches;
 *  `.hg` only matches when `.hg/requires` contains `treestate` (Sapling-specific). */
function detectSlRepo(cwd: string) {
  let current = resolve(cwd);
  for (;;) {
    if (fs.existsSync(join(current, ".sl"))) {
      return { id: "sl" as const, repoRoot: current };
    }
    const hgDir = join(current, ".hg");
    if (fs.existsSync(hgDir) && isSaplingHgRepo(hgDir)) {
      return { id: "sl" as const, repoRoot: current };
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Return the user-facing error for Sapling operations that only Git supports. */
function createSlUnsupportedStashShowError() {
  return new HunkUserError("`hunk stash show` requires Git VCS mode.", [
    'Set `vcs = "git"` in Hunk config, then try again.',
  ]);
}

/** Format one file stat into a stable signature fragment, or mark the path missing. */
function statSignature(path: string) {
  if (!fs.existsSync(path)) {
    return `${path}:missing`;
  }

  const stat = fs.statSync(path);
  return `${path}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}

/** VCS adapter translating neutral review operations to Sapling commands. */
export const slAdapter: VcsAdapter = {
  id: "sl",
  name: "Sapling",
  capabilities: {
    reviewOperations: new Set(["working-tree-diff", "revision-show"]),
    stagedDiff: false,
    watchSignatures: true,
  },

  detect: detectSlRepo,

  async loadReview(operation, { cwd }) {
    switch (operation.kind) {
      case "working-tree-diff": {
        const input = operation.input;
        if (input.staged) {
          throw createSlStagedError(input);
        }
        const repoRoot = resolveSlRepoRoot(input, { cwd });
        const repoName = basename(repoRoot);
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: input.range ? `${repoName} ${input.range}` : `${repoName} working copy`,
          patchText: runSlText({ input, args: buildSlDiffArgs(input), cwd }),
          untrackedFiles: listSlUntrackedFiles(input, { cwd, repoRoot }),
        };
      }
      case "revision-show": {
        const input = operation.input;
        const repoRoot = resolveSlRepoRoot(input, { cwd });
        const repoName = basename(repoRoot);
        const revset = input.ref ?? ".";
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: `${repoName} show ${revset}`,
          patchText: runSlText({ input, args: buildSlShowArgs(input), cwd }),
        };
      }
      case "stash-show":
        throw createSlUnsupportedStashShowError();
    }
  },

  watchSignature(operation, { cwd }) {
    switch (operation.kind) {
      case "working-tree-diff": {
        const input = operation.input;
        const trackedPatch = runSlText({ input, args: buildSlDiffArgs(input), cwd });
        const repoRoot = resolveSlRepoRoot(input, { cwd });
        const untrackedSignatures = listSlUntrackedFiles(input, { cwd, repoRoot }).map(
          (filePath) => `untracked:${statSignature(join(repoRoot, filePath))}`,
        );
        return [trackedPatch, ...untrackedSignatures].join("\n---\n");
      }
      case "revision-show": {
        const input = operation.input;
        return runSlText({ input, args: buildSlShowArgs(input), cwd });
      }
      case "stash-show":
        throw createSlUnsupportedStashShowError();
    }
  },
};
