import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  buildGitDiffArgs,
  buildGitDiffNumstatArgs,
  buildGitShowArgs,
  buildGitStashShowArgs,
  listGitIgnoredDirectoryRoots,
  listGitUntrackedFiles,
  listGitUntrackedFilesAsync,
  normalizeUntrackedPatchHeaders,
  parseGitNumstat,
  resolveGitColorMovedOptions,
  resolveGitCommitRef,
  resolveGitDiffEndpoints,
  resolveGitMetadata,
  resolveGitRepoRoot,
  resolveGitRepoRootAsync,
  runGitText,
  runGitTextAsync,
  runGitUntrackedFileDiffText,
  shouldSkipLargeTrackedDiff,
  type GitBackedInput,
  type GitDiffEndpoints,
} from "../../../../core/vcs/git";
import { gitEndpointSourceSpec, readGitFileSource } from "../../../../core/vcs/gitSource";
import { inspectLargeUntrackedFile } from "../../../../core/vcs/largeFile";
import {
  HUNK_CORE_VCS_DETECTION_PRIORITY,
  type ExtensionVcsAdapter,
  type ExtensionVcsDiffInput,
  type ExtensionVcsDirectoryTreeWatchTarget,
  type ExtensionVcsExtraFile,
  type ExtensionVcsFileSourceReader,
  type ExtensionVcsWatchPlan,
  type HunkExtensionAPI,
} from "../../../../extension-api/types";

/**
 * Hunk's Git backend, as a bundled extension.
 *
 * Git is the backend that exercises every integration point there is — exact
 * file sources, skipped-too-large placeholders, untracked files, watch plans,
 * rich failures — so it is deliberately written the way a third-party backend
 * would be: it sees only the published `hunkdiff/extension` contract plus its
 * own implementation helpers in `src/core/vcs/git.ts`, `src/core/vcs/gitSource.ts`, and
 * `src/core/vcs/largeFile.ts`. Nothing here reaches into the diff engine or the
 * adapter registry. If something Git needs cannot be said in these types, the
 * published contract is missing it, and that is the point of shipping it this
 * way.
 */

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

/** Format one file stat into a stable signature fragment, or mark the path missing. */
export function statSignature(path: string) {
  if (!fs.existsSync(path)) {
    return `${path}:missing`;
  }

  const stat = fs.statSync(path);
  return `${path}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}

/* -------------------------------------------------------------------------- */
/* Exact file sources                                                          */
/* -------------------------------------------------------------------------- */

/** Exact source reader plus a stable identity for its complete old/new snapshot. */
interface GitSourceCapability {
  readFileSource: ExtensionVcsFileSourceReader;
  sourceCacheKey: string;
}

/** Hash semantic index entries so filesystem-stat refreshes do not defeat cache reuse. */
function gitIndexCacheKey(input: GitBackedInput, repoRoot: string, gitExecutable: string) {
  const entries = runGitText({
    input,
    args: ["ls-files", "--stage", "-z"],
    cwd: repoRoot,
    gitExecutable,
  });
  return createHash("sha256").update(entries).digest("hex");
}

/** Describe one resolved endpoint for source-cache reuse across adapter reloads. */
function gitEndpointCacheKey(endpoint: GitDiffEndpoints["old"], indexCacheKey: string) {
  if (endpoint.kind === "git-ref") {
    return `ref:${endpoint.ref}`;
  }
  if (endpoint.kind === "index") {
    return `index:${indexCacheKey}`;
  }
  return endpoint.kind;
}

/**
 * Build a source reader that answers from exact Git old/new endpoints.
 *
 * The endpoint key omits worktree contents because the per-file patch fingerprint
 * already describes their delta. Immutable refs and the index hash identify the
 * base, so unchanged files can safely retain highlighting across watch reloads.
 */
function createGitSourceCapability(
  input: GitBackedInput,
  repoRoot: string,
  endpoints: GitDiffEndpoints,
  gitExecutable: string,
): GitSourceCapability {
  const needsIndex = endpoints.old.kind === "index" || endpoints.new.kind === "index";
  const indexCacheKey = needsIndex ? gitIndexCacheKey(input, repoRoot, gitExecutable) : "unused";

  return {
    sourceCacheKey: [
      "git-source-v1",
      gitEndpointCacheKey(endpoints.old, indexCacheKey),
      gitEndpointCacheKey(endpoints.new, indexCacheKey),
    ].join(":"),
    readFileSource: ({ path, previousPath, changeType, side }) => {
      // An added file has no old side and a deleted one has no new side; asking
      // Git for either would just be a failed lookup.
      if (side === "old") {
        return changeType === "new"
          ? Promise.resolve(null)
          : readGitFileSource(
              gitEndpointSourceSpec(endpoints.old, repoRoot, previousPath ?? path),
              {
                gitExecutable,
              },
            );
      }

      return changeType === "deleted"
        ? Promise.resolve(null)
        : readGitFileSource(gitEndpointSourceSpec(endpoints.new, repoRoot, path), {
            gitExecutable,
          });
    },
  };
}

/** Build a pinned source capability for a single-revision review. */
function createGitRevisionSourceCapability(
  input: GitBackedInput,
  ref: string,
  repoRoot: string,
  gitExecutable: string,
): GitSourceCapability {
  const newRef = resolveGitCommitRef(input, ref, { cwd: repoRoot, gitExecutable });
  return createGitSourceCapability(
    input,
    repoRoot,
    { old: { kind: "git-ref", ref: `${newRef}^` }, new: { kind: "git-ref", ref: newRef } },
    gitExecutable,
  );
}

/**
 * Build a source capability for a working-tree review, when both sides are exact.
 *
 * Ranges that do not reduce to one old/new pair — octopus merges, multi-positive
 * revision sets — deliberately get no reader at all rather than a guess, so
 * expanded rows are never read from the wrong revision.
 */
function createGitDiffSourceCapability(
  input: ExtensionVcsDiffInput,
  repoRoot: string,
  cwd: string,
  gitExecutable: string,
): GitSourceCapability | undefined {
  const endpoints = resolveGitDiffEndpoints(input, { cwd, repoRoot, gitExecutable });
  return endpoints
    ? createGitSourceCapability(input, repoRoot, endpoints, gitExecutable)
    : undefined;
}

/* -------------------------------------------------------------------------- */
/* Files reviewed outside the main patch                                       */
/* -------------------------------------------------------------------------- */

/**
 * Describe one untracked file for review.
 *
 * Git renders the addition itself rather than Hunk reading the working copy, so
 * its own binary detection and path quoting decide what the patch says — the
 * same output `git diff` would have produced for a tracked file.
 */
function buildUntrackedExtraFile(
  input: ExtensionVcsDiffInput,
  filePath: string,
  repoRoot: string,
  gitExecutable: string,
): ExtensionVcsExtraFile {
  const largeFileCheck = inspectLargeUntrackedFile(repoRoot, filePath);
  if (largeFileCheck.shouldSkip) {
    return {
      kind: "skipped",
      path: filePath,
      reason: "too-large",
      changeType: "new",
      isUntracked: true,
      stats: largeFileCheck.stats,
      statsTruncated: largeFileCheck.statsTruncated,
    };
  }

  return {
    kind: "patch",
    path: filePath,
    isUntracked: true,
    patchText: normalizeUntrackedPatchHeaders(
      runGitUntrackedFileDiffText(input, filePath, { repoRoot, gitExecutable }),
      filePath,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Watch plans                                                                 */
/* -------------------------------------------------------------------------- */

/** Return whether a recursive directory target safely covers another directory. */
function directoryContains(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Build metadata targets, collapsing linked-worktree state under its common Git directory. */
function buildGitMetadataTargets(
  gitDir: string,
  commonDir: string,
): ExtensionVcsDirectoryTreeWatchTarget[] {
  const directories = directoryContains(commonDir, gitDir) ? [commonDir] : [gitDir, commonDir];
  return directories.map((directory) => ({
    kind: "directory-tree",
    directory,
    ignoredRoots: [join(directory, "objects")],
    sources: ["vcs-metadata"],
  }));
}

/**
 * Build a Git watch plan whose worktree recursion matches the reviewed operation.
 *
 * Only a review that still has the live working tree on one side needs the
 * worktree watched; a commit-to-commit range changes only when Git metadata
 * does, and recursing the whole checkout for it would be wasted work.
 */
function buildGitWatchPlan(
  input: GitBackedInput,
  cwd: string,
  gitExecutable: string,
): ExtensionVcsWatchPlan {
  const metadata = resolveGitMetadata(input, { cwd, gitExecutable });
  const targets: ExtensionVcsDirectoryTreeWatchTarget[] = [];

  if (
    input.kind === "vcs" &&
    resolveGitDiffEndpoints(input, {
      cwd,
      repoRoot: metadata.repoRoot,
      gitExecutable,
    })?.new.kind === "worktree"
  ) {
    targets.push({
      kind: "directory-tree",
      directory: metadata.repoRoot,
      ignoredRoots: [
        ...new Set([
          join(metadata.repoRoot, ".git"),
          ...listGitIgnoredDirectoryRoots(input, {
            cwd: metadata.repoRoot,
            repoRoot: metadata.repoRoot,
            gitExecutable,
          }),
        ]),
      ],
      sources: ["worktree"],
    });
  }

  targets.push(...buildGitMetadataTargets(metadata.gitDir, metadata.commonDir));
  return { coverage: "hybrid", targets };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * VCS adapter translating neutral review operations to Git commands.
 *
 * Registered at the baseline detection priority: it is what every other
 * backend, bundled or installed, positions itself against.
 */
export const GitVcsAdapter = {
  id: "git",
  name: "Git",
  detect: detectGitRepo,
  detectionPriority: HUNK_CORE_VCS_DETECTION_PRIORITY,
  operations: {
    "working-tree-diff": {
      async load(input, { cwd, gitExecutable = "git" }) {
        const repoRoot = resolveGitRepoRoot(input, { cwd, gitExecutable });
        const repoName = basename(repoRoot);
        const title = input.staged
          ? `${repoName} staged changes`
          : input.range
            ? `${repoName} ${input.range}`
            : `${repoName} working tree`;
        // Ask for stats before the patch so files too large to render can be
        // excluded from the diff instead of generating output nobody reads.
        const largeTrackedFiles = parseGitNumstat(
          runGitText({ input, args: buildGitDiffNumstatArgs(input), cwd, gitExecutable }),
        ).filter((file) => shouldSkipLargeTrackedDiff(file, repoRoot));
        const colorMoved = resolveGitColorMovedOptions(input, { cwd, gitExecutable });
        const sourceCapability = createGitDiffSourceCapability(input, repoRoot, cwd, gitExecutable);

        return {
          repoRoot,
          sourceLabel: repoRoot,
          title,
          patchText: runGitText({
            input,
            args: buildGitDiffArgs(
              input,
              largeTrackedFiles.map((file) => file.path),
              colorMoved,
            ),
            cwd,
            gitExecutable,
          }),
          ...sourceCapability,
          extraFiles: [
            ...largeTrackedFiles.map(
              (file): ExtensionVcsExtraFile => ({
                kind: "skipped",
                path: file.path,
                reason: "too-large",
                changeType: "change",
                stats: { additions: file.additions, deletions: file.deletions },
              }),
            ),
            ...listGitUntrackedFiles(input, { cwd, repoRoot, gitExecutable }).map((filePath) =>
              buildUntrackedExtraFile(input, filePath, repoRoot, gitExecutable),
            ),
          ],
        };
      },
      watchPlan(input, { cwd, gitExecutable = "git" }) {
        return buildGitWatchPlan(input, cwd, gitExecutable);
      },
      // Watch signatures run on every debounced file event and every safety
      // poll while the TUI is drawing, so they use the non-blocking runners.
      // The one-shot `load` above stays synchronous, where blocking is free.
      async watchSignature(input, { cwd, gitExecutable = "git", signal }) {
        const gitOptions = { cwd, gitExecutable, preventOptionalLocks: true, signal };
        const trackedPatch = await runGitTextAsync({
          input,
          args: buildGitDiffArgs(input),
          ...gitOptions,
        });
        const repoRoot = await resolveGitRepoRootAsync(input, gitOptions);
        const untrackedSignatures = (
          await listGitUntrackedFilesAsync(input, { repoRoot, ...gitOptions })
        ).map((filePath) => `untracked:${statSignature(join(repoRoot, filePath))}`);
        return [trackedPatch, ...untrackedSignatures].join("\n---\n");
      },
    },
    "revision-show": {
      async load(input, { cwd, gitExecutable = "git" }) {
        const repoRoot = resolveGitRepoRoot(input, { cwd, gitExecutable });
        const repoName = basename(repoRoot);
        const sourceCapability = createGitRevisionSourceCapability(
          input,
          input.ref ?? "HEAD",
          repoRoot,
          gitExecutable,
        );

        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: input.ref ? `${repoName} show ${input.ref}` : `${repoName} show HEAD`,
          patchText: runGitText({
            input,
            args: buildGitShowArgs(
              input,
              resolveGitColorMovedOptions(input, { cwd, gitExecutable }),
            ),
            cwd,
            gitExecutable,
          }),
          ...sourceCapability,
        };
      },
      watchPlan(input, { cwd, gitExecutable = "git" }) {
        return buildGitWatchPlan(input, cwd, gitExecutable);
      },
      watchSignature(input, { cwd, gitExecutable = "git", signal }) {
        return runGitTextAsync({
          input,
          args: buildGitShowArgs(input),
          cwd,
          gitExecutable,
          preventOptionalLocks: true,
          signal,
        });
      },
    },
    "stash-show": {
      async load(input, { cwd, gitExecutable = "git" }) {
        const repoRoot = resolveGitRepoRoot(input, { cwd, gitExecutable });
        const repoName = basename(repoRoot);
        const sourceCapability = createGitRevisionSourceCapability(
          input,
          input.ref ?? "stash@{0}",
          repoRoot,
          gitExecutable,
        );

        return {
          repoRoot,
          sourceLabel: repoRoot,
          title: input.ref ? `${repoName} stash ${input.ref}` : `${repoName} stash`,
          patchText: runGitText({
            input,
            args: buildGitStashShowArgs(
              input,
              resolveGitColorMovedOptions(input, { cwd, gitExecutable }),
            ),
            cwd,
            gitExecutable,
          }),
          ...sourceCapability,
        };
      },
      watchPlan(input, { cwd, gitExecutable = "git" }) {
        return buildGitWatchPlan(input, cwd, gitExecutable);
      },
      watchSignature(input, { cwd, gitExecutable = "git", signal }) {
        return runGitTextAsync({
          input,
          args: buildGitStashShowArgs(input),
          cwd,
          gitExecutable,
          preventOptionalLocks: true,
          signal,
        });
      },
    },
  },
} satisfies ExtensionVcsAdapter;

export default function (hunk: HunkExtensionAPI) {
  hunk.registerVcsAdapter(GitVcsAdapter);
}
