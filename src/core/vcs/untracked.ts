import { createTwoFilesPatch } from "diff";
import fs from "node:fs";
import { join } from "node:path";
import { createSkippedBinaryMetadata, isProbablyBinaryFile } from "../binary";
import { buildDiffFile, createSkippedLargeMetadata } from "../diffFile";
import { inspectLargeUntrackedFile } from "../largeFile";
import { escapeUntrackedPatchPath } from "../patch/normalize";
import { parseSingleFilePatch } from "../patch/singleFile";
import type { LargeFileCheck } from "../largeFile";

/**
 * Host-side synthesis of untracked files into reviewable diffs.
 *
 * This is the half of the `untrackedPaths` contract Hunk owns: an adapter says
 * which paths its VCS considers unknown, and everything below turns each one
 * into an added-file diff — or a placeholder when it is binary or too large.
 */

/** Build a skipped placeholder for one untracked file that is too large to render. */
export function buildSkippedLargeUntrackedDiffFile(
  filePath: string,
  index: number,
  sourcePrefix: string,
  largeFileCheck: LargeFileCheck,
) {
  return buildDiffFile(createSkippedLargeMetadata(filePath, "new"), "", index, sourcePrefix, null, {
    isTooLarge: true,
    isUntracked: true,
    stats: largeFileCheck.stats,
    statsTruncated: largeFileCheck.statsTruncated,
  });
}

/** Build one filesystem-backed untracked file diff from its current contents. */
export function buildFilesystemUntrackedDiffFile(
  repoRoot: string,
  filePath: string,
  index: number,
  sourcePrefix: string,
) {
  const absolutePath = join(repoRoot, filePath);
  const largeFileCheck = inspectLargeUntrackedFile(repoRoot, filePath);
  if (largeFileCheck.shouldSkip) {
    return buildSkippedLargeUntrackedDiffFile(filePath, index, sourcePrefix, largeFileCheck);
  }

  if (isProbablyBinaryFile(absolutePath)) {
    return buildDiffFile(
      createSkippedBinaryMetadata(filePath, "new"),
      `Binary file skipped: ${filePath}\n`,
      index,
      sourcePrefix,
      null,
      { isBinary: true, isUntracked: true },
    );
  }

  const patch = createTwoFilesPatch(
    "/dev/null",
    escapeUntrackedPatchPath(filePath),
    "",
    fs.readFileSync(absolutePath, "utf8"),
    "",
    "",
    { context: 3 },
  ).replaceAll("\r\n", "\n");

  return buildDiffFile(parseSingleFilePatch(patch, filePath), patch, index, sourcePrefix, null, {
    isUntracked: true,
  });
}
