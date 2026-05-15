import { getFiletypeFromFileName, type FileDiffMetadata } from "@pierre/diffs";
import { findAgentFileContext } from "./agent";
import { patchLooksBinary } from "./binary";
import { normalizeDiffMetadataPaths, normalizeDiffPath } from "./diffPaths";
import type { AgentContext, DiffFile } from "./types";

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

export interface BuildDiffFileOptions {
  isUntracked?: boolean;
  previousPath?: string;
  isBinary?: boolean;
  isTooLarge?: boolean;
  stats?: DiffFile["stats"];
  statsTruncated?: boolean;
}

/** Build the normalized per-file model used by the UI regardless of input mode. */
export function buildDiffFile(
  metadata: FileDiffMetadata,
  patch: string,
  index: number,
  sourcePrefix: string,
  agentContext: AgentContext | null,
  {
    isUntracked,
    previousPath,
    isBinary,
    isTooLarge,
    stats,
    statsTruncated,
  }: BuildDiffFileOptions = {},
): DiffFile {
  const normalizedMetadata = normalizeDiffMetadataPaths(metadata);
  const path = normalizedMetadata.name;
  const resolvedPreviousPath = normalizeDiffPath(previousPath) ?? normalizedMetadata.prevName;

  return {
    id: `${sourcePrefix}:${index}:${path}`,
    path,
    previousPath: resolvedPreviousPath,
    patch,
    language: getFiletypeFromFileName(path) ?? undefined,
    stats: stats ?? countDiffStats(normalizedMetadata),
    metadata: normalizedMetadata,
    agent: findAgentFileContext(agentContext, path, resolvedPreviousPath),
    isUntracked,
    isBinary: isBinary ?? patchLooksBinary(patch),
    isTooLarge,
    statsTruncated,
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
