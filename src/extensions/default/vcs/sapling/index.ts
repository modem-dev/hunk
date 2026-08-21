import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describeDiffRange } from "../diffRange";
import {
  buildSlDiffArgs,
  buildSlShowArgs,
  createSlStagedError,
  listSlUntrackedFiles,
  resolveSlRepoRoot,
  runSlText,
} from "./commands";
import {
  HUNK_VCS_DETECTION_BASELINE_PRIORITY,
  type ExtensionVcsAdapter,
  type HunkExtensionAPI,
} from "hunkdiff/extension";

/**
 * Hunk's Sapling backend, as a bundled extension.
 *
 * Like the Jujutsu one, this file sees only the published contract plus helpers
 * owned by this extension directory.
 */

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

/** Format one file stat into a stable signature fragment, or mark the path missing. */
function statSignature(path: string) {
  if (!fs.existsSync(path)) {
    return `${path}:missing`;
  }

  const stat = fs.statSync(path);
  return `${path}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}

/** VCS adapter translating neutral review operations to Sapling commands. */
export const SaplingVcsAdapter = {
  id: "sl",
  name: "Sapling",
  detect: detectSlRepo,
  // Above Git for the same reason Jujutsu is: `sl init --git` leaves Git
  // metadata behind, and the Sapling working copy is the one under review.
  detectionPriority: HUNK_VCS_DETECTION_BASELINE_PRIORITY + 100,
  operations: {
    "working-tree-diff": {
      async load(input, { cwd }) {
        if (input.staged) {
          throw createSlStagedError(input);
        }
        const repoRoot = resolveSlRepoRoot(input, { cwd });
        const repoName = basename(repoRoot);
        const range = describeDiffRange(input);
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: range ? `${repoName} ${range}` : `${repoName} working copy`,
          patchText: runSlText({ input, args: buildSlDiffArgs(input), cwd }),
          untrackedPaths: listSlUntrackedFiles(input, { cwd, repoRoot }),
        };
      },
      watchSignature(input, { cwd }) {
        const trackedPatch = runSlText({ input, args: buildSlDiffArgs(input), cwd });
        const repoRoot = resolveSlRepoRoot(input, { cwd });
        const untrackedSignatures = listSlUntrackedFiles(input, { cwd, repoRoot }).map(
          (filePath) => `untracked:${statSignature(join(repoRoot, filePath))}`,
        );
        return [trackedPatch, ...untrackedSignatures].join("\n---\n");
      },
    },
    "revision-show": {
      async load(input, { cwd }) {
        const repoRoot = resolveSlRepoRoot(input, { cwd });
        const repoName = basename(repoRoot);
        const revset = input.ref ?? ".";
        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: `${repoName} show ${revset}`,
          patchText: runSlText({ input, args: buildSlShowArgs(input), cwd }),
        };
      },
      watchSignature(input, { cwd }) {
        return runSlText({ input, args: buildSlShowArgs(input), cwd });
      },
    },
  },
} satisfies ExtensionVcsAdapter;

export default function (hunk: HunkExtensionAPI) {
  hunk.registerVcsAdapter(SaplingVcsAdapter);
}
