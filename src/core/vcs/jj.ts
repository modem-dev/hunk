import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HunkUserError } from "../errors";
import {
  buildJjDiffArgs,
  buildJjShowArgs,
  createJjStagedError,
  resolveJjRepoRoot,
  runJjText,
} from "../jj";
import type { VcsAdapter } from "./types";

/** Return the last path segment for review titles. */
function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Walk upward to detect a Jujutsu workspace marker without spawning JJ during config resolution. */
function detectJjRepo(cwd: string) {
  let current = resolve(cwd);
  for (;;) {
    if (fs.existsSync(join(current, ".jj"))) {
      return { id: "jj" as const, repoRoot: current };
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Return the user-facing error for Jujutsu operations that only Git supports. */
function createJjUnsupportedStashShowError() {
  return new HunkUserError("`hunk stash show` requires Git VCS mode.", [
    'Set `vcs = "git"` in Hunk config, then try again.',
  ]);
}

/** VCS adapter translating neutral review operations to Jujutsu commands. */
export const jjAdapter: VcsAdapter = {
  id: "jj",
  name: "Jujutsu",
  capabilities: {
    reviewOperations: new Set(["working-tree-diff", "revision-show"]),
    stagedDiff: false,
    watchSignatures: true,
  },

  detect: detectJjRepo,

  async loadReview(operation, { cwd }) {
    switch (operation.kind) {
      case "working-tree-diff": {
        const input = operation.input;
        if (input.staged) {
          throw createJjStagedError(input);
        }
        const repoRoot = resolveJjRepoRoot(input, { cwd });
        const repoName = basename(repoRoot);
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: input.range ? `${repoName} ${input.range}` : `${repoName} working copy`,
          patchText: runJjText({ input, args: buildJjDiffArgs(input), cwd }),
        };
      }
      case "revision-show": {
        const input = operation.input;
        const repoRoot = resolveJjRepoRoot(input, { cwd });
        const repoName = basename(repoRoot);
        const revset = input.ref ?? "@";
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: `${repoName} show ${revset}`,
          patchText: runJjText({ input, args: buildJjShowArgs(input), cwd }),
        };
      }
      case "stash-show":
        throw createJjUnsupportedStashShowError();
    }
  },

  watchSignature(operation) {
    switch (operation.kind) {
      case "working-tree-diff": {
        const input = operation.input;
        return runJjText({ input, args: buildJjDiffArgs(input) });
      }
      case "revision-show": {
        const input = operation.input;
        return runJjText({ input, args: buildJjShowArgs(input) });
      }
      case "stash-show":
        throw createJjUnsupportedStashShowError();
    }
  },
};
