import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildGitDiffArgs,
  buildGitDiffNumstatArgs,
  buildGitShowArgs,
  buildGitStashShowArgs,
  listGitUntrackedFiles,
  resolveGitRepoRoot,
  runGitText,
} from "../git";
import { createSkippedLargeMetadata } from "../diffFile";
import type { DiffFile } from "../types";
import type { VcsAdapter } from "./types";

const LARGE_DIFF_FILE_MAX_BYTES = 1_000_000;
const LARGE_DIFF_FILE_MAX_LINES = 20_000;

/** Return the last path segment for review titles. */
function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Walk upward to detect a Git worktree marker without spawning Git during config resolution. */
function detectGitRepo(cwd: string) {
  let current = resolve(cwd);
  for (;;) {
    if (fs.existsSync(join(current, ".git"))) {
      return { id: "git" as const, repoRoot: current };
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

interface GitNumstatFile {
  path: string;
  additions: number;
  deletions: number;
}

/** Parse `git diff --numstat -z` output for normal path entries. */
function parseGitNumstat(text: string): GitNumstatFile[] {
  return text
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const [additionsText, deletionsText, path] = entry.split("\t");
      if (!additionsText || !deletionsText || !path) {
        return [];
      }

      const additions = Number.parseInt(additionsText, 10);
      const deletions = Number.parseInt(deletionsText, 10);
      if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
        return [];
      }

      return [{ path, additions, deletions }];
    });
}

/** Return whether tracked diff stats are too large to render by default. */
function shouldSkipLargeTrackedDiff(file: GitNumstatFile, repoRoot: string) {
  if (file.additions + file.deletions > LARGE_DIFF_FILE_MAX_LINES) {
    return true;
  }

  try {
    return fs.statSync(join(repoRoot, file.path)).size > LARGE_DIFF_FILE_MAX_BYTES;
  } catch {
    return false;
  }
}

/** Build a tracked placeholder for a file whose diff would be too expensive to render. */
function buildSkippedLargeTrackedDiffFile(
  file: GitNumstatFile,
  index: number,
  sourcePrefix: string,
): DiffFile {
  return {
    id: `${sourcePrefix}:${index}:${file.path}`,
    path: file.path,
    patch: "",
    stats: { additions: file.additions, deletions: file.deletions },
    metadata: createSkippedLargeMetadata(file.path, "change"),
    agent: null,
    isTooLarge: true,
  };
}

/** VCS adapter translating neutral review operations to Git commands. */
export const gitAdapter: VcsAdapter = {
  id: "git",
  name: "Git",
  capabilities: {
    reviewOperations: new Set(["working-tree-diff", "revision-show", "stash-show"]),
    stagedDiff: true,
    watchSignatures: true,
  },

  detect: detectGitRepo,

  async loadReview(operation, { cwd, gitExecutable = "git" }) {
    switch (operation.kind) {
      case "working-tree-diff": {
        const input = operation.input;
        const repoRoot = resolveGitRepoRoot(input, { cwd, gitExecutable });
        const repoName = basename(repoRoot);
        const title = input.staged
          ? `${repoName} staged changes`
          : input.range
            ? `${repoName} ${input.range}`
            : `${repoName} working tree`;
        const largeTrackedFiles = parseGitNumstat(
          runGitText({ input, args: buildGitDiffNumstatArgs(input), cwd, gitExecutable }),
        ).filter((file) => shouldSkipLargeTrackedDiff(file, repoRoot));
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title,
          patchText: runGitText({
            input,
            args: buildGitDiffArgs(
              input,
              largeTrackedFiles.map((file) => file.path),
            ),
            cwd,
            gitExecutable,
          }),
          untrackedFiles: listGitUntrackedFiles(input, { cwd, repoRoot, gitExecutable }),
          extraFiles: largeTrackedFiles.map((file, index) =>
            buildSkippedLargeTrackedDiffFile(file, index, repoRoot),
          ),
        };
      }
      case "revision-show": {
        const input = operation.input;
        const repoRoot = resolveGitRepoRoot(input, { cwd, gitExecutable });
        const repoName = basename(repoRoot);
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: input.ref ? `${repoName} show ${input.ref}` : `${repoName} show HEAD`,
          patchText: runGitText({ input, args: buildGitShowArgs(input), cwd, gitExecutable }),
        };
      }
      case "stash-show": {
        const input = operation.input;
        const repoRoot = resolveGitRepoRoot(input, { cwd, gitExecutable });
        const repoName = basename(repoRoot);
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: input.ref ? `${repoName} stash ${input.ref}` : `${repoName} stash`,
          patchText: runGitText({ input, args: buildGitStashShowArgs(input), cwd, gitExecutable }),
        };
      }
    }
  },

  watchSignature(operation) {
    switch (operation.kind) {
      case "working-tree-diff": {
        const input = operation.input;
        const trackedPatch = runGitText({ input, args: buildGitDiffArgs(input) });
        const repoRoot = resolveGitRepoRoot(input);
        const untrackedSignatures = listGitUntrackedFiles(input, { repoRoot }).map(
          (filePath) => `untracked:${statSignature(join(repoRoot, filePath))}`,
        );
        return [trackedPatch, ...untrackedSignatures].join("\n---\n");
      }
      case "revision-show": {
        const input = operation.input;
        return runGitText({ input, args: buildGitShowArgs(input) });
      }
      case "stash-show": {
        const input = operation.input;
        return runGitText({ input, args: buildGitStashShowArgs(input) });
      }
    }
  },
};

/** Format one file stat into a stable signature fragment, or mark the path missing. */
function statSignature(path: string) {
  if (!fs.existsSync(path)) {
    return `${path}:missing`;
  }

  const stat = fs.statSync(path);
  return `${path}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}
