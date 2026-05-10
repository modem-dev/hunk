import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { patchLooksBinary } from "../core/binary";
import { normalizeDiffMetadataPaths, normalizeDiffPath } from "../core/diffPaths";
import type { DiffFile } from "../core/types";
import type { HunkDiffFile, HunkDiffFileInput } from "./types";

const NORMALIZED_HUNK_DIFF_FILES = new WeakSet<HunkDiffFile>();

/** Split a patch stream into per-file chunks for public OpenTUI file helpers. */
function splitPatchIntoFileChunks(rawPatch: string) {
  const patch = rawPatch.replaceAll("\r\n", "\n");
  const lines = patch.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  const hasGitHeaders = lines.some((line) => line.startsWith("diff --git "));

  const flush = () => {
    if (current.length > 0) {
      chunks.push(`${current.join("\n").trimEnd()}\n`);
      current = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (hasGitHeaders && line.startsWith("diff --git ")) {
      flush();
      current.push(line);
      continue;
    }

    if (!hasGitHeaders && line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      flush();
      current.push(line);
      current.push(lines[index + 1]!);
      index += 1;
      continue;
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  flush();
  return chunks;
}

/** Find the original per-file patch chunk for parsed metadata. */
function findPatchChunk(metadata: FileDiffMetadata, chunks: string[], index: number) {
  const byIndex = chunks[index];
  if (byIndex) {
    return byIndex;
  }

  const paths = [metadata.name, metadata.prevName]
    .map(normalizeDiffPath)
    .filter((value): value is string => Boolean(value));

  return chunks.find((chunk) => paths.some((path) => chunk.includes(path))) ?? "";
}

/** Count visible additions and deletions from Pierre metadata. */
export function countHunkDiffStats(metadata: FileDiffMetadata) {
  let additions = 0;
  let deletions = 0;

  for (const hunk of metadata.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions;
        deletions += content.deletions;
      }
    }
  }

  return { additions, deletions };
}

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
  const chunks = splitPatchIntoFileChunks(patchText);

  return parsePatchFiles(patchText, sourceId, true)
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
