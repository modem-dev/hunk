import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildSlDiffArgs,
  buildSlShowArgs,
  createSlStagedError,
  listSlUntrackedFiles,
  listSlUntrackedFilesAsync,
  resolveSlRepoRoot,
  resolveSlRepoRootAsync,
  runSlText,
  runSlTextAsync,
} from "./commands";
import { describeDiffRange } from "@hunk/vcs/diff-target";
import { createSlCommitReview, createSlComparisonReview } from "./reviewInfo";
import {
  HUNK_VCS_DETECTION_BASELINE_PRIORITY,
  type ExtensionVcsAdapter,
  type ExtensionVcsDiffInput,
  type ExtensionVcsShowInput,
  type HunkExtensionAPI,
} from "hunkdiff/extension";

/**
 * Hunk's Sapling backend, as a bundled extension.
 *
 * Like the Jujutsu one, this file sees only the published `hunkdiff/extension`
 * contract, explicit `@hunk/vcs` infrastructure leaves, and modules owned by
 * this package.
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

export interface SaplingVcsAdapterOptions {
  slExecutable?: string;
}

/** Create a Sapling adapter with provider-owned process dependencies. */
export function createSaplingVcsAdapter({
  slExecutable = "sl",
}: Readonly<SaplingVcsAdapterOptions> = {}) {
  return {
    id: "sl",
    name: "Sapling",
    detect: detectSlRepo,
    // Above Git for the same reason Jujutsu is: `sl init --git` leaves Git
    // metadata behind, and the Sapling working copy is the one under review.
    detectionPriority: HUNK_VCS_DETECTION_BASELINE_PRIORITY + 100,
    operations: {
      "working-tree-diff": {
        async load(input, { cwd, signal }) {
          if (input.staged) {
            throw createSlStagedError(input);
          }
          const diffArgs = buildSlDiffArgs(input);
          const repoRoot = await resolveSlRepoRootAsync(input, { cwd, slExecutable, signal });
          const repoName = basename(repoRoot);
          const range = describeDiffRange(input);
          const review = input.rangeEndpoints
            ? await createSlComparisonReview(
                input,
                input.rangeEndpoints.from,
                input.rangeEndpoints.to,
                { cwd: repoRoot, slExecutable, signal },
              )
            : undefined;
          const patchInput: ExtensionVcsDiffInput =
            review?.kind === "comparison"
              ? {
                  ...input,
                  range: undefined,
                  rangeEndpoints: { from: review.base, to: review.head },
                }
              : input;
          return {
            repoRoot,
            sourceLabel: repoRoot,
            title: range ? `${repoName} ${range}` : `${repoName} working copy`,
            patchText: await runSlTextAsync({
              input,
              args: review?.kind === "comparison" ? buildSlDiffArgs(patchInput) : diffArgs,
              cwd,
              slExecutable,
              signal,
            }),
            review,
            untrackedPaths: await listSlUntrackedFilesAsync(input, {
              cwd,
              repoRoot,
              slExecutable,
              signal,
            }),
          };
        },
        watchSignature(input, { cwd }) {
          const trackedPatch = runSlText({
            input,
            args: buildSlDiffArgs(input),
            cwd,
            slExecutable,
          });
          const repoRoot = resolveSlRepoRoot(input, { cwd, slExecutable });
          const untrackedSignatures = listSlUntrackedFiles(input, {
            cwd,
            repoRoot,
            slExecutable,
          }).map((filePath) => `untracked:${statSignature(join(repoRoot, filePath))}`);
          return [trackedPatch, ...untrackedSignatures].join("\n---\n");
        },
      },
      "revision-show": {
        async load(input, { cwd, signal }) {
          const repoRoot = await resolveSlRepoRootAsync(input, { cwd, slExecutable, signal });
          const repoName = basename(repoRoot);
          const revset = input.ref ?? ".";
          const review = await createSlCommitReview(input, revset, {
            cwd: repoRoot,
            slExecutable,
            signal,
          });
          const patchInput: ExtensionVcsShowInput =
            review?.kind === "commit" ? { ...input, ref: review.revision } : input;
          return {
            repoRoot,
            sourceLabel: repoRoot,
            title: `${repoName} show ${revset}`,
            patchText: await runSlTextAsync({
              input,
              args: buildSlShowArgs(patchInput),
              cwd,
              slExecutable,
              signal,
            }),
            review,
          };
        },
        watchSignature(input, { cwd }) {
          return runSlText({ input, args: buildSlShowArgs(input), cwd, slExecutable });
        },
      },
    },
  } satisfies ExtensionVcsAdapter;
}

export const SaplingVcsAdapter = createSaplingVcsAdapter();

export default function (hunk: HunkExtensionAPI) {
  hunk.registerVcsAdapter(SaplingVcsAdapter);
}
