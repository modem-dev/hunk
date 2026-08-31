import {
  buildDiffFile,
  createSkippedLargeMetadata,
  type BuildDiffFileOptions,
} from "../core/changeset/diffFile";
import { isAbsolute } from "node:path";
import { parseSingleFilePatch } from "../core/patch/singleFile";
import {
  DEFAULT_SOURCE_TEXT_MAX_BYTES,
  SourceTextTooLargeError,
  type FileSourceSide,
} from "../core/changeset/fileSource";
import type { DiffFile } from "../core/changeset/model";
import type { VcsPatchResult } from "../core/vcs/types";
import type {
  ExtensionVcsExtraFile,
  ExtensionVcsFileSourceReader,
  ExtensionVcsFileSourcePathResolver,
  ExtensionVcsFileSourceRequest,
  ExtensionVcsPatchResult,
} from "../extension-api/types";

/**
 * Turning a published VCS patch result into the model Hunk reviews.
 *
 * The published result describes files; the internal one holds the diff
 * engine's parsed model of them. Every adapter Hunk ships — Git included —
 * crosses this boundary, so a capability that cannot be expressed here is a
 * capability the published contract is genuinely missing.
 */

type SourceFetcherBuilder = NonNullable<BuildDiffFileOptions["sourceFetcherBuilder"]>;
type SourcePathBuilder = NonNullable<BuildDiffFileOptions["sourcePathBuilder"]>;

/** Build one public source request from normalized per-file context. */
function sourceRequest(
  file: Parameters<SourceFetcherBuilder>[0],
  side: FileSourceSide,
): ExtensionVcsFileSourceRequest {
  return {
    path: file.path,
    previousPath: file.previousPath,
    changeType: file.type,
    isUntracked: file.isUntracked,
    side,
  };
}

/**
 * Adapt a published per-file source reader to the internal per-file fetcher.
 *
 * Two policies live here rather than in each adapter. Binary files are never
 * read, because there is no source text worth highlighting and every backend
 * would otherwise repeat the check. And each side is read at most once and
 * cached, so the published contract can promise that and adapters can stay
 * stateless. Ordinary rejected reads remain retryable, while a structural
 * too-large answer is cached and rethrown without asking the adapter again.
 */
function toSourceFetcherBuilder(
  read: ExtensionVcsFileSourceReader,
  sourceCacheKey: string | undefined,
): SourceFetcherBuilder {
  return (file) => {
    if (file.isBinary) {
      return undefined;
    }

    const cache = new Map<FileSourceSide, string | null>();
    const tooLargeCache = new Map<FileSourceSide, number>();

    return {
      cacheKey: sourceCacheKey,
      async getFullText(side) {
        if (cache.has(side)) {
          return cache.get(side) ?? null;
        }
        const cachedLimit = tooLargeCache.get(side);
        if (cachedLimit !== undefined) {
          throw new SourceTextTooLargeError(cachedLimit);
        }

        const result = await read(sourceRequest(file, side));
        if (typeof result === "object" && result !== null) {
          if (result.kind === "too-large") {
            const maxBytes =
              typeof result.maxBytes === "number" &&
              Number.isFinite(result.maxBytes) &&
              result.maxBytes > 0
                ? result.maxBytes
                : DEFAULT_SOURCE_TEXT_MAX_BYTES;
            tooLargeCache.set(side, maxBytes);
            throw new SourceTextTooLargeError(maxBytes);
          }
          throw new Error("VCS source readers must return text, null, or a too-large result.");
        }

        cache.set(side, result);
        return result;
      },
    };
  };
}

/** Adapt a published path resolver to normalized per-file filesystem provenance. */
function toSourcePathBuilder(resolvePath: ExtensionVcsFileSourcePathResolver): SourcePathBuilder {
  return (file) => {
    const resolveSide = (side: FileSourceSide) => {
      const path = resolvePath(sourceRequest(file, side));
      return path !== null && isAbsolute(path) ? path : null;
    };
    const old = resolveSide("old");
    const next = resolveSide("new");
    return old === null && next === null ? undefined : { old, new: next };
  };
}

/**
 * Build the diff model for one file an adapter reported outside its patch text.
 *
 * A skipped entry gets placeholder metadata and no source fetcher — there is
 * nothing to render and nothing to expand — while a patch entry is parsed like
 * any other file and relabeled with the path the adapter declared.
 */
function toInternalExtraFile(
  entry: ExtensionVcsExtraFile,
  index: number,
  sourcePrefix: string,
  sourceFetcherBuilder: SourceFetcherBuilder | undefined,
  sourcePathBuilder: SourcePathBuilder | undefined,
): DiffFile {
  if (entry.kind === "skipped") {
    return buildDiffFile(
      createSkippedLargeMetadata(entry.path, entry.changeType ?? "change"),
      "",
      index,
      sourcePrefix,
      null,
      {
        previousPath: entry.previousPath,
        isUntracked: entry.isUntracked,
        isTooLarge: true,
        stats: entry.stats,
        statsTruncated: entry.statsTruncated,
        sourcePathBuilder,
      },
    );
  }

  return buildDiffFile(
    parseSingleFilePatch(entry.patchText, entry.path, entry.previousPath),
    entry.patchText,
    index,
    sourcePrefix,
    null,
    {
      previousPath: entry.previousPath,
      isUntracked: entry.isUntracked,
      sourceFetcherBuilder,
      sourcePathBuilder,
    },
  );
}

/** Convert one published patch result into the internal result loaders consume. */
export function toInternalVcsPatchResult(result: ExtensionVcsPatchResult): VcsPatchResult {
  const sourceFetcherBuilder = result.readFileSource
    ? toSourceFetcherBuilder(result.readFileSource, result.sourceCacheKey)
    : undefined;
  const sourcePathBuilder = result.resolveFileSourcePath
    ? toSourcePathBuilder(result.resolveFileSourcePath)
    : undefined;

  return {
    repoRoot: result.repoRoot,
    sourceLabel: result.sourceLabel,
    title: result.title,
    patchText: result.patchText,
    untrackedPaths: result.untrackedPaths,
    sourceFetcherBuilder,
    sourcePathBuilder,
    extraFiles: result.extraFiles?.map((entry, index) =>
      toInternalExtraFile(entry, index, result.repoRoot, sourceFetcherBuilder, sourcePathBuilder),
    ),
  };
}
