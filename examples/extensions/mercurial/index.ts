import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  HUNK_VCS_DETECTION_BASELINE_PRIORITY,
  type ExtensionFactory,
  type ExtensionVcsAdapter,
  type ExtensionVcsDiffInput,
  type ExtensionVcsFileSourceReader,
  type ExtensionVcsShowInput,
} from "hunkdiff/extension";
import {
  buildHgDiffArgs,
  buildHgShowArgs,
  buildHgUnknownArgs,
  createHgStagedError,
  hasWorkingCopyEndpoint,
  parseHgRange,
  parseHgUnknownPaths,
  readHgCommittedFile,
  resolveHgNode,
  resolveHgRepoRoot,
  runHgText,
  type HgBackedInput,
  type HgRange,
} from "./commands.js";

/** Return whether `.hg/requires` carries Sapling's exact `treestate` marker. */
export function hasSaplingTreestateRequirement(hgDirectory: string) {
  try {
    return readFileSync(join(hgDirectory, "requires"), "utf8").split(/\r?\n/).includes("treestate");
  } catch {
    return false;
  }
}

/** Walk upward to find an upstream Mercurial checkout, declining Sapling repos. */
export function detectMercurialRepo(cwd: string) {
  let current = resolve(cwd);
  for (;;) {
    const hgDirectory = join(current, ".hg");
    if (existsSync(hgDirectory)) {
      return hasSaplingTreestateRequirement(hgDirectory)
        ? null
        : { id: "hg" as const, repoRoot: current };
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Return a stable title label for a repository root. */
function repositoryName(repoRoot: string) {
  return repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? repoRoot;
}

/** Resolve a protocol path within the repository without allowing traversal. */
function resolveWorkingCopyPath(repoRoot: string, filePath: string) {
  const absolutePath = resolve(repoRoot, filePath);
  const fromRoot = relative(repoRoot, absolutePath);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    return null;
  }
  return absolutePath;
}

/** Read a working-copy file with tracked or host-synthesized symlink semantics. */
function readWorkingCopyFile(repoRoot: string, filePath: string, isUntracked: boolean) {
  const absolutePath = resolveWorkingCopyPath(repoRoot, filePath);
  if (absolutePath === null) {
    return null;
  }
  try {
    const info = lstatSync(absolutePath);
    if (info.isSymbolicLink()) {
      return isUntracked ? readFileSync(absolutePath, "utf8") : readlinkSync(absolutePath, "utf8");
    }
    return info.isFile() ? readFileSync(absolutePath, "utf8") : null;
  } catch {
    return null;
  }
}

/** Return whether an unknown path resolves to a reviewable regular file. */
function isReviewableUnknownPath(repoRoot: string, filePath: string) {
  const absolutePath = resolveWorkingCopyPath(repoRoot, filePath);
  if (absolutePath === null) {
    return false;
  }
  try {
    // Follow symlinks because Hunk's host-side untracked synthesis reads the
    // referent. Broken links and directories cannot become filesystem diffs.
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/** Hash an unknown file incrementally, following symlinks like Hunk's renderer. */
function unknownFileSignature(repoRoot: string, filePath: string) {
  const absolutePath = resolveWorkingCopyPath(repoRoot, filePath);
  if (absolutePath === null) {
    return `${filePath}:outside-repository`;
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolutePath, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    return `${filePath}:${hash.digest("hex")}`;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
    return `${filePath}:${code}`;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/** List unknown files only when the diff's new endpoint is the live working copy. */
function listHgUnknownFiles(input: ExtensionVcsDiffInput, repoRoot: string) {
  if (input.options.excludeUntracked === true || !hasWorkingCopyEndpoint(input)) {
    return [];
  }
  return parseHgUnknownPaths(
    runHgText({ input, args: buildHgUnknownArgs(input), cwd: repoRoot }),
  ).filter((filePath) => isReviewableUnknownPath(repoRoot, filePath));
}

interface HgSourceEndpoints {
  oldRevision: string | null;
  newRevision: string | null;
  newIsWorkingCopy: boolean;
}

/** Pin both source endpoints used by a working-copy/range diff. */
function resolveDiffSourceEndpoints(
  input: ExtensionVcsDiffInput,
  repoRoot: string,
): HgSourceEndpoints {
  const range = parseHgRange(input.range);
  if (range.kind === "revision-pair") {
    return {
      oldRevision: resolveHgNode(input, range.oldRevision, { cwd: repoRoot }),
      newRevision: resolveHgNode(input, range.newRevision, { cwd: repoRoot }),
      newIsWorkingCopy: false,
    };
  }
  return {
    oldRevision: resolveHgNode(
      input,
      range.kind === "revision-to-working-copy" ? range.revision : ".",
      { cwd: repoRoot },
    ),
    newRevision: null,
    newIsWorkingCopy: true,
  };
}

/** Pin the shown changeset and its first parent for exact source reads. */
function resolveShowSourceEndpoints(
  input: ExtensionVcsShowInput,
  repoRoot: string,
): HgSourceEndpoints {
  const newRevision = resolveHgNode(input, input.ref ?? ".", { cwd: repoRoot });
  const oldRevision = resolveHgNode(input, `p1(${newRevision})`, { cwd: repoRoot }) || null;
  return { oldRevision, newRevision, newIsWorkingCopy: false };
}

/** Build a lazy exact-source reader honoring rename paths and absent sides. */
function createHgSourceReader(
  input: HgBackedInput,
  repoRoot: string,
  endpoints: HgSourceEndpoints,
): ExtensionVcsFileSourceReader {
  return async ({ path, previousPath, changeType, isUntracked, side }) => {
    if ((side === "old" && changeType === "new") || (side === "new" && changeType === "deleted")) {
      return null;
    }
    if (side === "new" && endpoints.newIsWorkingCopy) {
      return readWorkingCopyFile(repoRoot, path, isUntracked);
    }
    const revision = side === "old" ? endpoints.oldRevision : endpoints.newRevision;
    const sourcePath = side === "old" ? (previousPath ?? path) : path;
    return readHgCommittedFile(input, revision, sourcePath, { cwd: repoRoot });
  };
}

/** Hash opaque source or watch-state parts into one stable identity. */
function stateKey(prefix: string, parts: string[]) {
  return `${prefix}:${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
}

/** Convert pinned source endpoints back into Mercurial's explicit diff range. */
function pinnedDiffRange(endpoints: HgSourceEndpoints): HgRange {
  if (endpoints.newIsWorkingCopy) {
    return {
      kind: "revision-to-working-copy",
      revision: endpoints.oldRevision!,
    };
  }
  return {
    kind: "revision-pair",
    oldRevision: endpoints.oldRevision!,
    newRevision: endpoints.newRevision!,
  };
}

/** Load the tracked patch, unknown paths, and exact sources for one review. */
function loadWorkingCopyState(
  input: ExtensionVcsDiffInput,
  cwd: string,
  includeWatchSignature = false,
) {
  if (input.staged) {
    throw createHgStagedError(input);
  }
  const repoRoot = resolveHgRepoRoot(input, { cwd });
  // Pin symbolic revisions before producing the patch so lazy source reads
  // cannot resolve a bookmark or working parent to a different changeset.
  const endpoints = resolveDiffSourceEndpoints(input, repoRoot);
  const patchText = runHgText({
    input,
    args: buildHgDiffArgs(input, pinnedDiffRange(endpoints)),
    cwd: repoRoot,
  });
  const untrackedPaths = listHgUnknownFiles(input, repoRoot);
  const endpointKey = `${endpoints.oldRevision ?? "null"}:${endpoints.newRevision ?? "working-copy"}`;
  const watchSignature = includeWatchSignature
    ? stateKey("hg-watch-v1", [
        endpointKey,
        patchText,
        ...untrackedPaths.map((filePath) => unknownFileSignature(repoRoot, filePath)),
      ])
    : undefined;
  return {
    result: {
      repoRoot,
      sourceLabel: repoRoot,
      title: input.range
        ? `${repositoryName(repoRoot)} ${input.range}`
        : `${repositoryName(repoRoot)} working copy`,
      patchText,
      untrackedPaths,
      readFileSource: createHgSourceReader(input, repoRoot, endpoints),
      // The per-file patch fingerprint already identifies live contents. This
      // key only pins source state outside that fingerprint.
      sourceCacheKey: stateKey("hg-source-v1", [endpointKey]),
    },
    watchSignature,
  };
}

/** Load one committed revision and pin its exact old/new endpoints. */
function loadRevisionState(input: ExtensionVcsShowInput, cwd: string) {
  const repoRoot = resolveHgRepoRoot(input, { cwd });
  const endpoints = resolveShowSourceEndpoints(input, repoRoot);
  const patchText = runHgText({
    input,
    args: buildHgShowArgs(input, endpoints.newRevision ?? undefined),
    cwd: repoRoot,
  });
  const revision = input.ref ?? ".";
  const endpointKey = `${endpoints.oldRevision ?? "null"}:${endpoints.newRevision ?? "null"}`;
  return {
    result: {
      repoRoot,
      sourceLabel: repoRoot,
      title: `${repositoryName(repoRoot)} show ${revision}`,
      patchText,
      readFileSource: createHgSourceReader(input, repoRoot, endpoints),
      sourceCacheKey: stateKey("hg-source-v1", [endpointKey]),
    },
    watchSignature: stateKey("hg-watch-v1", [endpointKey, patchText]),
  };
}

/** Create the installable Mercurial adapter. */
export function createMercurialVcsAdapter() {
  return {
    id: "hg",
    name: "Mercurial",
    detect: detectMercurialRepo,
    // Git is the baseline. A colocated upstream `.hg` marker is authoritative,
    // so Mercurial wins that same-root tie; Sapling remains above it and is also
    // explicitly declined by detection when `treestate` is present.
    detectionPriority: HUNK_VCS_DETECTION_BASELINE_PRIORITY + 50,
    operations: {
      "working-tree-diff": {
        async load(input, { cwd }) {
          return loadWorkingCopyState(input, cwd).result;
        },
        watchPlan() {
          return { coverage: "poll-only", targets: [] };
        },
        watchSignature(input, { cwd }) {
          return loadWorkingCopyState(input, cwd, true).watchSignature!;
        },
      },
      "revision-show": {
        async load(input, { cwd }) {
          return loadRevisionState(input, cwd).result;
        },
        watchPlan() {
          return { coverage: "poll-only", targets: [] };
        },
        watchSignature(input, { cwd }) {
          return loadRevisionState(input, cwd).watchSignature;
        },
      },
    },
  } satisfies ExtensionVcsAdapter;
}

export const MercurialVcsAdapter = createMercurialVcsAdapter();

const mercurialExtension: ExtensionFactory = (hunk) => {
  hunk.registerVcsAdapter(MercurialVcsAdapter);
};

export default mercurialExtension;
