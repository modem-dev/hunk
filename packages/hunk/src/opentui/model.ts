import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { patchLooksBinary } from "../core/changeset/binary";
import { normalizeDiffMetadataPaths, normalizeDiffPath } from "../core/changeset/diffPaths";
import { countDiffStats } from "../core/changeset/diffFile";
import { splitPatchIntoFileChunks, findPatchChunk } from "../core/patch/chunks";
import { sanitizePatch } from "../core/patch/sanitize";
import type { DiffFile } from "../core/changeset/model";
import type { HunkDiffFile, HunkDiffFileInput, HunkDiffStats } from "./types";

const NORMALIZED_HUNK_DIFF_FILES = new WeakSet<HunkDiffFile>();

/** Count visible additions and deletions from Pierre metadata. */
export function countHunkDiffStats(metadata: FileDiffMetadata): HunkDiffStats {
  return countDiffStats(metadata);
}

/** Build one public file while optionally preserving paths decoded exactly from Git quoting. */
function buildHunkDiffFile(input: HunkDiffFileInput, pathsAreExact: boolean): HunkDiffFile {
  const metadata = pathsAreExact ? input.metadata : normalizeDiffMetadataPaths(input.metadata);
  const path = pathsAreExact
    ? (input.path ?? metadata.name)
    : (normalizeDiffPath(input.path) ?? metadata.name);
  const previousPath = pathsAreExact
    ? (input.previousPath ?? metadata.prevName)
    : (normalizeDiffPath(input.previousPath) ?? metadata.prevName);
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

/** Build Hunk's public OpenTUI file model with normalized paths and default stats. */
export function createHunkDiffFile(input: HunkDiffFileInput): HunkDiffFile {
  return buildHunkDiffFile(input, false);
}

/** Return an already-normalized public file as-is, or normalize a raw input shape. */
function resolveHunkDiffFile(input: HunkDiffFileInput) {
  if (NORMALIZED_HUNK_DIFF_FILES.has(input as HunkDiffFile)) {
    return input as HunkDiffFile;
  }

  return createHunkDiffFile(input);
}

/** @internal Adapt the public OpenTUI file shape into Hunk's internal review file model. */
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
  const sanitizedPatch = sanitizePatch(patchText);
  const chunks = splitPatchIntoFileChunks(sanitizedPatch.text);

  return parsePatchFiles(sanitizedPatch.text, sourceId, true)
    .flatMap((entry) => entry.files)
    .map((metadata, index) => {
      const decodedPaths = sanitizedPatch.filePaths[index];
      const normalizedMetadata = decodedPaths
        ? { ...metadata, name: decodedPaths.path, prevName: decodedPaths.previousPath }
        : metadata;

      return buildHunkDiffFile(
        {
          id: `${sourceId}:${index}:${normalizedMetadata.name}`,
          metadata: normalizedMetadata,
          patch: findPatchChunk(metadata, chunks, index),
        },
        Boolean(decodedPaths),
      );
    });
}

/** @internal Adapt a list of public OpenTUI files into Hunk's internal review file model. */
export function toInternalDiffFiles(files: HunkDiffFileInput[]) {
  return files.map(toInternalDiffFile);
}
