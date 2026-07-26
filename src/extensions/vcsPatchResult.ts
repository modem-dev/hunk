import {
  buildDiffFile,
  createSkippedLargeMetadata,
  type BuildDiffFileOptions,
} from "../core/diffFile";
import { parseSingleFilePatch } from "../core/patch/singleFile";
import type { FileSourceSide } from "../core/fileSource";
import type { DiffFile } from "../core/types";
import type { VcsPatchResult } from "../core/vcs/types";
import type {
  ExtensionVcsExtraFile,
  ExtensionVcsFileSourceReader,
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

/**
 * Adapt a published per-file source reader to the internal per-file fetcher.
 *
 * Two policies live here rather than in each adapter. Binary files are never
 * read, because there is no source text worth highlighting and every backend
 * would otherwise repeat the check. And each side is read at most once and
 * cached, so the published contract can promise that and adapters can stay
 * stateless. A rejected read is deliberately left uncached: a source that was
 * too large to expand once should be retried, not remembered as broken.
 */
function toSourceFetcherBuilder(read: ExtensionVcsFileSourceReader): SourceFetcherBuilder {
  return (file) => {
    if (file.isBinary) {
      return undefined;
    }

    const cache = new Map<FileSourceSide, string | null>();

    return {
      async getFullText(side) {
        if (cache.has(side)) {
          return cache.get(side) ?? null;
        }

        const text = await read({
          path: file.path,
          previousPath: file.previousPath,
          changeType: file.type,
          isUntracked: file.isUntracked,
          side,
        });
        cache.set(side, text);
        return text;
      },
    };
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
    },
  );
}

/** Convert one published patch result into the internal result loaders consume. */
export function toInternalVcsPatchResult(result: ExtensionVcsPatchResult): VcsPatchResult {
  const sourceFetcherBuilder = result.readFileSource
    ? toSourceFetcherBuilder(result.readFileSource)
    : undefined;

  return {
    repoRoot: result.repoRoot,
    sourceLabel: result.sourceLabel,
    title: result.title,
    patchText: result.patchText,
    untrackedPaths: result.untrackedPaths,
    sourceFetcherBuilder,
    extraFiles: result.extraFiles?.map((entry, index) =>
      toInternalExtraFile(entry, index, result.repoRoot, sourceFetcherBuilder),
    ),
  };
}
