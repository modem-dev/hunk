import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/** VCS adapter translating neutral review operations to Jujutsu commands. */
export const JjVcsAdapter: VcsAdapter = {
  id: "jj",
  name: "Jujutsu",
  detect: detectJjRepo,
  operations: {
    "working-tree-diff": {
      async load(input, { cwd }) {
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
      },
      watchSignature(input, { cwd }) {
        return runJjText({ input, args: buildJjDiffArgs(input), cwd });
      },
    },
    "revision-show": {
      async load(input, { cwd }) {
        const repoRoot = resolveJjRepoRoot(input, { cwd });
        const repoName = basename(repoRoot);
        const revset = input.ref ?? "@";
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: `${repoName} show ${revset}`,
          patchText: runJjText({ input, args: buildJjShowArgs(input), cwd }),
        };
      },
      watchSignature(input, { cwd }) {
        return runJjText({ input, args: buildJjShowArgs(input), cwd });
      },
    },
  },
};
