/**
 * Acquires a changeset from whichever source the CLI selected.
 *
 * One loader per source shape — a VCS review, a direct file comparison, a patch file or
 * stdin — and each ends by handing text to `changesetFromPatch`. This module owns the I/O
 * (spawning, reading, stat-ing); the model it produces is built next door.
 */
import { parseDiffFromFile, type FileContents, type FileDiffMetadata } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { resolve as resolvePath } from "node:path";
import { findSidecarFileContext, loadSidecarContext } from "./sidecar";
import { createSkippedBinaryMetadata, isProbablyBinaryFile } from "./binary";
import { buildDiffFile, type BuildDiffFileOptions, type DiffFileSourceContext } from "./diffFile";
import { createFileSourceFetcher, type FileSourceSpec } from "./fileSource";
import { changesetFromPatch } from "./fromPatch";

import {
  getConfiguredVcsAdapter,
  isVcsReviewInput,
  loadVcsReview,
  operationFromInput,
} from "../vcs";
import type { VcsCatalog } from "../vcs/types";
import { buildFilesystemUntrackedDiffFile } from "../vcs/untracked";
import { computeWatchSignature } from "../watch/signature";
import type {
  CliInput,
  DiffToolCommandInput,
  FileCommandInput,
  PatchCommandInput,
  VcsShowCommandInput,
  VcsDiffCommandInput,
  VcsStashShowCommandInput,
} from "../run/commandInputs";
import type { SidecarContext, Changeset, DiffFile } from "./model";

export interface LoadChangesetOptions {
  cwd?: string;
  /** Complete adapter catalog composed by the app for this session. */
  vcsCatalog?: VcsCatalog;
}

/** One loaded changeset plus the acquisition facts a reload or watch needs. */
export interface LoadedChangeset {
  changeset: Changeset;
  repoRoot?: string;
  initialWatchSignature?: string;
}

/** Return the final path segment for display-oriented labels. */
function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

interface ResolvedFileSourceSpecs {
  old: FileSourceSpec;
  new: FileSourceSpec;
}

/** Build a binary-aware source-fetcher factory from per-file source specs. */
function createSourceFetcherBuilder(
  resolveSpecs: (file: DiffFileSourceContext) => ResolvedFileSourceSpecs | undefined,
): NonNullable<BuildDiffFileOptions["sourceFetcherBuilder"]> {
  return (file) => {
    if (file.isBinary) {
      return undefined;
    }

    const specs = resolveSpecs(file);
    return specs ? createFileSourceFetcher(specs) : undefined;
  };
}

/** Reorder files to follow agent-context narrative order when a sidecar provides one. */
export function orderDiffFiles(files: DiffFile[], sidecar: SidecarContext | null) {
  if (!sidecar || sidecar.files.length === 0) {
    return files;
  }

  const ranks = new Map<string, number>();

  sidecar.files.forEach((file, index) => {
    if (!ranks.has(file.path)) {
      ranks.set(file.path, index);
    }
  });

  return files
    .map((file, index) => {
      const rankCandidates = [file.path, file.previousPath]
        .filter((path): path is string => Boolean(path))
        .map((path) => ranks.get(path))
        .filter((rank): rank is number => rank !== undefined);

      return {
        file,
        index,
        rank: rankCandidates.length > 0 ? Math.min(...rankCandidates) : Number.POSITIVE_INFINITY,
      };
    })
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.file);
}

/** Return the change type to show when direct file comparison skips binary contents. */
function resolveBinaryComparisonType(
  leftPath: string,
  rightPath: string,
): FileDiffMetadata["type"] {
  if (leftPath === "/dev/null") {
    return "new";
  }

  if (rightPath === "/dev/null") {
    return "deleted";
  }

  return "change";
}

/** Build a placeholder changeset for direct file comparisons that include binary content. */
function buildBinaryFileDiffChangeset(
  input: FileCommandInput | DiffToolCommandInput,
  displayPath: string,
  title: string,
  leftPath: string,
  rightPath: string,
  sidecar: SidecarContext | null,
) {
  return {
    id: `pair:${displayPath}`,
    sourceLabel: input.kind === "difftool" ? "git difftool" : "file compare",
    title,
    agentSummary: sidecar?.summary,
    files: [
      buildDiffFile(
        createSkippedBinaryMetadata(displayPath, resolveBinaryComparisonType(leftPath, rightPath)),
        `Binary file skipped: ${basename(input.left)} ↔ ${basename(input.right)}\n`,
        0,
        displayPath,
        sidecar,
        {
          previousPath: basename(input.left),
          isBinary: true,
        },
      ),
    ],
  } satisfies Changeset;
}

/** Build a changeset by diffing two concrete files on disk. */
async function loadFileDiffChangeset(
  input: FileCommandInput | DiffToolCommandInput,
  sidecar: SidecarContext | null,
  cwd = process.cwd(),
) {
  const leftPath = resolvePath(cwd, input.left);
  const rightPath = resolvePath(cwd, input.right);
  const displayPath =
    input.kind === "difftool" ? (input.path ?? basename(input.right)) : basename(input.right);
  const title =
    input.kind === "difftool"
      ? `git difftool: ${displayPath}`
      : input.left === input.right
        ? displayPath
        : `${basename(input.left)} ↔ ${basename(input.right)}`;

  if (isProbablyBinaryFile(leftPath) || isProbablyBinaryFile(rightPath)) {
    return buildBinaryFileDiffChangeset(input, displayPath, title, leftPath, rightPath, sidecar);
  }

  const leftText = await Bun.file(leftPath).text();
  const rightText = await Bun.file(rightPath).text();
  const oldFile: FileContents = {
    name: displayPath,
    contents: leftText,
    cacheKey: `${leftPath}:left`,
  };
  const newFile: FileContents = {
    name: displayPath,
    contents: rightText,
    cacheKey: `${rightPath}:right`,
  };

  const metadata = parseDiffFromFile(oldFile, newFile, { context: 3 }, true);
  const patch = createTwoFilesPatch(displayPath, displayPath, leftText, rightText, "", "", {
    context: 3,
  });

  return {
    id: `pair:${displayPath}`,
    sourceLabel: input.kind === "difftool" ? "git difftool" : "file compare",
    title,
    agentSummary: sidecar?.summary,
    files: [
      buildDiffFile(metadata, patch, 0, displayPath, sidecar, {
        previousPath: basename(input.left),
        sourceFetcherBuilder: createSourceFetcherBuilder(() => ({
          old: { kind: "fs", absolutePath: leftPath },
          new: { kind: "fs", absolutePath: rightPath },
        })),
      }),
    ],
  } satisfies Changeset;
}

/** Build a changeset from an adapter-backed VCS review operation. */
async function loadVcsChangeset(
  input: VcsDiffCommandInput | VcsShowCommandInput | VcsStashShowCommandInput,
  sidecar: SidecarContext | null,
  cwd: string,
  vcsCatalog: VcsCatalog,
) {
  const adapter = getConfiguredVcsAdapter(input.options.vcs, vcsCatalog);
  const operation = operationFromInput(input);
  const result = await loadVcsReview(adapter, operation, { cwd }, vcsCatalog);
  const parsedChangeset = changesetFromPatch(
    result.patchText,
    result.title,
    result.sourceLabel,
    sidecar,
    result.sourceFetcherBuilder ? { sourceFetcherBuilder: result.sourceFetcherBuilder } : undefined,
  );
  // Two published ways to review a file the patch does not contain, and both
  // land here: `untrackedPaths`, where an adapter names what its VCS considers
  // unknown and Hunk synthesizes the added-file diffs, and `extraFiles`, where
  // the adapter described the file itself and the conversion boundary already
  // turned each entry into a diff file. Adapter-described files come first, so
  // an adapter that uses both keeps its own ordering.
  const untrackedFiles = (result.untrackedPaths ?? []).map((filePath, index) =>
    buildFilesystemUntrackedDiffFile(
      result.repoRoot,
      filePath,
      (result.extraFiles?.length ?? 0) + index,
      result.repoRoot,
    ),
  );
  const adapterFiles = [...(result.extraFiles ?? []), ...untrackedFiles].map((file, index) => ({
    ...file,
    id: `${file.id}:extra:${index}`,
    agent: findSidecarFileContext(sidecar, file.path, file.previousPath),
  }));
  return {
    changeset: {
      ...parsedChangeset,
      files: [...parsedChangeset.files, ...adapterFiles],
    } satisfies Changeset,
    repoRoot: result.repoRoot,
  };
}

/** Build a changeset from patch text supplied by file or stdin. */
async function loadPatchChangeset(
  input: PatchCommandInput,
  sidecar: SidecarContext | null,
  cwd = process.cwd(),
) {
  const patchText =
    input.text ??
    (!input.file || input.file === "-"
      ? await new Response(Bun.stdin.stream()).text()
      : await Bun.file(resolvePath(cwd, input.file)).text());

  const label = input.file && input.file !== "-" ? input.file : "stdin patch";
  return changesetFromPatch(patchText, `Patch review: ${basename(label)}`, label, sidecar);
}

/** Load the changeset (and its acquisition facts) for one CLI input. */
export async function loadChangeset(
  input: CliInput,
  { cwd = process.cwd(), vcsCatalog }: LoadChangesetOptions = {},
): Promise<LoadedChangeset> {
  // Capture before loading content so watch mode can detect mutations that race initial loading.
  let initialWatchSignature: string | undefined;
  if (input.options.watch) {
    try {
      if (vcsCatalog || !isVcsReviewInput(input)) {
        initialWatchSignature = computeWatchSignature(input, { cwd, vcsCatalog });
      }
    } catch {
      // A transient signature failure must not prevent an otherwise valid initial review.
    }
  }

  const sidecar = await loadSidecarContext(input.options.agentContext, { cwd });

  let changeset: Changeset;
  let repoRoot: string | undefined;

  switch (input.kind) {
    case "vcs":
    case "show":
    case "stash-show":
      {
        if (!vcsCatalog) {
          throw new Error("VCS-backed reviews require a composed VCS catalog.");
        }
        const result = await loadVcsChangeset(input, sidecar, cwd, vcsCatalog);
        changeset = result.changeset;
        repoRoot = result.repoRoot;
      }
      break;
    case "diff":
      changeset = await loadFileDiffChangeset(input, sidecar, cwd);
      break;
    case "patch":
      changeset = await loadPatchChangeset(input, sidecar, cwd);
      break;
    case "difftool":
      changeset = await loadFileDiffChangeset(input, sidecar, cwd);
      break;
  }

  changeset = {
    ...changeset,
    files: orderDiffFiles(changeset.files, sidecar),
  };

  return { changeset, repoRoot, initialWatchSignature };
}
