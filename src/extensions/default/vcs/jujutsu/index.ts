import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  buildJjDiffArgs,
  buildJjShowArgs,
  createJjStagedError,
  resolveJjDiffEndpoints,
  resolveJjRangeEndpoints,
  resolveJjRepoRoot,
  runJjText,
  type JjDiffEndpoints,
} from "./commands";
import { openJjHistory } from "./history";
import { readJjFileSource } from "./source";
import { describeDiffRange } from "../diffRange";
import {
  HUNK_VCS_DETECTION_BASELINE_PRIORITY,
  type ExtensionVcsAdapter,
  type ExtensionVcsFileSourceReader,
  type HunkExtensionAPI,
} from "hunkdiff/extension";

/**
 * Hunk's Jujutsu backend, as a bundled extension.
 *
 * This file is written the way a third-party VCS extension would be: it sees
 * only the published `hunkdiff/extension` contract plus implementation helpers
 * owned by this extension directory. If something here cannot be said in those
 * types, the contract is missing something.
 */

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

/* -------------------------------------------------------------------------- */
/* Exact file sources                                                          */
/* -------------------------------------------------------------------------- */

/** Lets Hunk load complete files later and recognize when cached source is still current. */
interface JjSourceCapability {
  readFileSource: ExtensionVcsFileSourceReader;
  sourceCacheKey: string;
}

/** Include every resolved old-side commit in retained source identity. */
function jjOldSideCacheKey(oldCommitIds: string[]) {
  return oldCommitIds.length === 1
    ? `commit:${oldCommitIds[0]}`
    : `merged-parents:${oldCommitIds.join(",")}`;
}

/**
 * Let Hunk load complete file text when a user expands context omitted from the patch.
 *
 * `jj diff` includes changed lines and only a few unchanged lines around them. When the
 * user expands a collapsed gap, Hunk calls `readFileSource` for the rest of the file.
 * This reader uses commit IDs resolved before the patch was generated, so the returned
 * text still matches the review even if `@` or a bookmark has moved. The cache key names
 * both sides of that resolved diff so Hunk never carries source text across a change to
 * either side.
 *
 * With exactly one parent, the old text comes from that commit and the new text comes
 * from the reviewed commit. The old side of a rename uses `previousPath`; added files
 * and root commits have no old text, while deleted files have no new text. A merge is
 * different: JJ compares it with a virtual tree made by merging all parents, but
 * `jj file show` cannot read that virtual tree. The new side is still exact and can
 * expand gaps, while old-side reads return `null` rather than showing content from an
 * arbitrary parent.
 */
function createJjSourceCapability(
  repoRoot: string,
  endpoints: JjDiffEndpoints,
  jjExecutable: string,
): JjSourceCapability {
  const oldCommitId = endpoints.oldCommitIds.length === 1 ? endpoints.oldCommitIds[0] : undefined;

  return {
    sourceCacheKey: [
      "jj-source-v1",
      jjOldSideCacheKey(endpoints.oldCommitIds),
      `commit:${endpoints.newCommitId}`,
    ].join(":"),
    readFileSource: ({ path, previousPath, changeType, side }) => {
      if (side === "old") {
        if (changeType === "new" || oldCommitId === undefined) {
          return Promise.resolve(null);
        }
        return readJjFileSource(
          { repoRoot, commitId: oldCommitId, path: previousPath ?? path },
          { jjExecutable },
        );
      }

      return changeType === "deleted"
        ? Promise.resolve(null)
        : readJjFileSource({ repoRoot, commitId: endpoints.newCommitId, path }, { jjExecutable });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                 */
/* -------------------------------------------------------------------------- */

export interface JjVcsAdapterOptions {
  jjExecutable?: string;
}

/** Create a Jujutsu adapter, optionally using a caller-supplied `jj` executable. */
export function createJjVcsAdapter({ jjExecutable = "jj" }: Readonly<JjVcsAdapterOptions> = {}) {
  return {
    id: "jj",
    name: "Jujutsu",
    detect: detectJjRepo,
    // Above Git: a colocated jj repository carries a `.git` directory too, and
    // reviewing it as plain Git would show the wrong working copy.
    detectionPriority: HUNK_VCS_DETECTION_BASELINE_PRIORITY + 200,
    history: {
      open(input, { cwd }) {
        return openJjHistory(input, { cwd, jjExecutable });
      },
      // JJ's single-revision diff compares ordinary commits with their parent,
      // merges with their merged-parent tree, and first commits with the root.
      planReview(commit) {
        return { kind: "revision-show" as const, revisionId: commit.revisionId };
      },
    },
    operations: {
      "working-tree-diff": {
        async load(input, { cwd }) {
          if (input.staged) {
            throw createJjStagedError(input);
          }
          const repoRoot = resolveJjRepoRoot(input, { cwd, jjExecutable });
          const repoName = basename(repoRoot);
          const sourceEndpoints = input.rangeEndpoints
            ? resolveJjRangeEndpoints(input, input.rangeEndpoints, { cwd, jjExecutable })
            : resolveJjDiffEndpoints(input, input.range ?? "@", { cwd, jjExecutable });
          const sourceCapability = sourceEndpoints
            ? createJjSourceCapability(repoRoot, sourceEndpoints, jjExecutable)
            : undefined;
          const pinnedInput = input.rangeEndpoints
            ? sourceEndpoints?.oldCommitIds.length === 1
              ? {
                  from: sourceEndpoints.oldCommitIds[0]!,
                  to: sourceEndpoints.newCommitId,
                }
              : undefined
            : sourceEndpoints?.newCommitId;
          const range = describeDiffRange(input);
          return {
            repoRoot,
            sourceLabel: repoRoot,
            title: range ? `${repoName} ${range}` : `${repoName} working copy`,
            patchText: runJjText({
              input,
              args: buildJjDiffArgs(input, pinnedInput),
              cwd,
              jjExecutable,
            }),
            ...sourceCapability,
          };
        },
        watchSignature(input, { cwd }) {
          return runJjText({
            input,
            args: buildJjDiffArgs(input, undefined, true),
            cwd,
            jjExecutable,
          });
        },
      },
      "revision-show": {
        async load(input, { cwd }) {
          const repoRoot = resolveJjRepoRoot(input, { cwd, jjExecutable });
          const repoName = basename(repoRoot);
          const revset = input.ref ?? "@";
          const sourceEndpoints = resolveJjDiffEndpoints(input, revset, {
            cwd,
            jjExecutable,
          });
          const sourceCapability = sourceEndpoints
            ? createJjSourceCapability(repoRoot, sourceEndpoints, jjExecutable)
            : undefined;
          return {
            repoRoot,
            sourceLabel: repoRoot,
            title: `${repoName} show ${revset}`,
            patchText: runJjText({
              input,
              args: buildJjShowArgs(input, sourceEndpoints?.newCommitId),
              cwd,
              jjExecutable,
            }),
            ...sourceCapability,
          };
        },
        watchSignature(input, { cwd }) {
          return runJjText({ input, args: buildJjShowArgs(input), cwd, jjExecutable });
        },
      },
    },
  } satisfies ExtensionVcsAdapter;
}

export const JjVcsAdapter = createJjVcsAdapter();

export default function (hunk: HunkExtensionAPI) {
  hunk.registerVcsAdapter(JjVcsAdapter);
}
