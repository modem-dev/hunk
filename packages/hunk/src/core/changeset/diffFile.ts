import { setLanguageOverride, type FileDiffMetadata } from "@pierre/diffs";
import { findSidecarFileContext } from "./sidecar";
import { patchLooksBinary } from "./binary";
import { fileLanguageForPath } from "./fileLanguageLookup";
import { normalizeDiffMetadataPaths, normalizeDiffPath } from "./diffPaths";
import type { FileSourceFetcher } from "./fileSource";
import type { DiffFile, DiffLineMoveKinds, SidecarContext } from "./model";

/** Count visible additions and deletions from parsed diff metadata. */
export function countDiffStats(metadata: FileDiffMetadata) {
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

export interface DiffFileSourceContext {
  path: string;
  previousPath?: string;
  type: FileDiffMetadata["type"];
  isUntracked: boolean;
  isBinary: boolean;
}

export interface BuildDiffFileOptions {
  isUntracked?: boolean;
  previousPath?: string;
  isBinary?: boolean;
  sourceFetcherBuilder?: (file: DiffFileSourceContext) => FileSourceFetcher | undefined;
  isTooLarge?: boolean;
  stats?: DiffFile["stats"];
  statsTruncated?: boolean;
  lineMoveKinds?: DiffLineMoveKinds;
  pathsAreExact?: boolean;
}

/** Build the normalized per-file model used by the UI regardless of input mode. */
export function buildDiffFile(
  metadata: FileDiffMetadata,
  patch: string,
  index: number,
  sourcePrefix: string,
  sidecar: SidecarContext | null,
  {
    isUntracked,
    previousPath,
    isBinary,
    sourceFetcherBuilder,
    isTooLarge,
    stats,
    statsTruncated,
    lineMoveKinds,
    pathsAreExact,
  }: BuildDiffFileOptions = {},
): DiffFile {
  const normalizedMetadata = pathsAreExact ? metadata : normalizeDiffMetadataPaths(metadata);
  const path = normalizedMetadata.name;
  const resolvedPreviousPath = pathsAreExact
    ? (previousPath ?? normalizedMetadata.prevName)
    : (normalizeDiffPath(previousPath) ?? normalizedMetadata.prevName);
  const resolvedIsBinary = isBinary ?? patchLooksBinary(patch);
  const language = fileLanguageForPath(path);
  const sourceFetcher = sourceFetcherBuilder?.({
    path,
    previousPath: resolvedPreviousPath,
    type: normalizedMetadata.type,
    isUntracked: Boolean(isUntracked),
    isBinary: resolvedIsBinary,
  });

  return {
    id: `${sourcePrefix}:${index}:${path}`,
    path,
    previousPath: resolvedPreviousPath,
    patch,
    language,
    stats: stats ?? countDiffStats(normalizedMetadata),
    // Pierre otherwise re-derives the language from the path and cannot see Hunk-only selectors.
    metadata: setLanguageOverride(normalizedMetadata, language),
    lineMoveKinds,
    agent: findSidecarFileContext(sidecar, path, resolvedPreviousPath),
    isUntracked,
    isBinary: resolvedIsBinary,
    isTooLarge,
    statsTruncated,
    sourceFetcher,
  };
}

/** Build placeholder metadata for a file whose full diff would be too expensive. */
export function createSkippedLargeMetadata(
  filePath: string,
  type: FileDiffMetadata["type"],
): FileDiffMetadata {
  return {
    name: filePath,
    type,
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    additionLines: [],
    deletionLines: [],
    cacheKey: `${filePath}:large-diff-skipped`,
  };
}
