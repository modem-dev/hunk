import { parsePatchFiles } from "@pierre/diffs";
import { patchLooksBinary } from "../core/binary";
import { normalizeDiffMetadataPaths, normalizeDiffPath } from "../core/diffPaths";
import { countDiffStats } from "../core/diffFile";
import { splitPatchIntoFileChunks, findPatchChunk } from "../core/patch/chunks";
import { normalizePatchText } from "../core/patch/normalize";
import type { DiffFile } from "../core/types";
import type { HunkDiffFile, HunkDiffFileInput } from "./types";

const NORMALIZED_HUNK_DIFF_FILES = new WeakSet<HunkDiffFile>();

/** Count visible additions and deletions from Pierre metadata. */
export const countHunkDiffStats = countDiffStats;

/** Build Hunk's public OpenTUI file model with normalized paths and default stats. */
export function createHunkDiffFile(input: HunkDiffFileInput): HunkDiffFile {
  const metadata = normalizeDiffMetadataPaths(input.metadata);
  const path = normalizeDiffPath(input.path) ?? metadata.name;
  const previousPath = normalizeDiffPath(input.previousPath) ?? metadata.prevName;
  const normalized = {
    ...input,
    id: input.id,
    metadata,
    path,
    previousPath,
    stats: input.stats ?? countHunkDiffStats(metadata),
  } satisfies HunkDiffFile;

  NORMALIZED_HUNK_DIFF_FILES.add(normalized);
  return normalized;
}

/** Return an already-normalized public file as-is, or normalize a raw input shape. */
function resolveHunkDiffFile(input: HunkDiffFileInput) {
  if (NORMALIZED_HUNK_DIFF_FILES.has(input as HunkDiffFile)) {
    return input as HunkDiffFile;
  }

  return createHunkDiffFile(input);
}

/** Adapt the public OpenTUI file shape into Hunk's internal review file model. */
export function toInternalDiffFile(diff: HunkDiffFileInput): DiffFile {
  const normalized = resolveHunkDiffFile(diff);
  const patch = normalized.patch ?? "";

  return {
    agent: null,
    id: normalized.id,
    isBinary: normalized.isBinary ?? patchLooksBinary(patch),
    isTooLarge: normalized.isTooLarge,
    isUntracked: normalized.isUntracked,
    language: normalized.language,
    metadata: normalized.metadata,
    patch,
    path: normalized.path ?? normalized.metadata.name,
    previousPath: normalized.previousPath,
    stats: normalized.stats,
    statsTruncated: normalized.statsTruncated,
  };
}

/** Parse unified diff text into Hunk's public OpenTUI file model. */
export function createHunkDiffFilesFromPatch(patchText: string, sourceId = "patch") {
  const normalizedPatchText = normalizePatchText(patchText);
  const chunks = splitPatchIntoFileChunks(normalizedPatchText);

  return parsePatchFiles(normalizedPatchText, sourceId, true)
    .flatMap((entry) => entry.files)
    .map((metadata, index) =>
      createHunkDiffFile({
        id: `${sourceId}:${index}:${normalizeDiffPath(metadata.name) ?? metadata.name}`,
        metadata,
        patch: findPatchChunk(metadata, chunks, index),
      }),
    );
}

/** Adapt a list of public OpenTUI files into Hunk's internal review file model. */
export function toInternalDiffFiles(files: HunkDiffFileInput[]) {
  return files.map(toInternalDiffFile);
}
