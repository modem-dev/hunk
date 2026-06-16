import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import fs from "node:fs";
import { join } from "node:path";
import { createSkippedBinaryMetadata, isProbablyBinaryFile } from "../binary";
import { buildDiffFile, createSkippedLargeMetadata } from "../diffFile";
import { escapeUntrackedPatchPath } from "../patch/normalize";
import type { DiffFile } from "../types";

const LARGE_DIFF_FILE_MAX_BYTES = 1_000_000;
const LARGE_DIFF_FILE_MAX_LINES = 20_000;
const LARGE_DIFF_FILE_SNIFF_BYTES = 256 * 1024;

interface CountedLines {
  complete: boolean;
  lines: number;
}

/** Count text lines with a byte cap so huge skipped-file stats do not block startup. */
function countLinesInFile(path: string, maxBytes: number, size: number): CountedLines {
  let fd: number | undefined;

  try {
    fd = fs.openSync(path, "r");
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes));
    let position = 0;
    let lineCount = 0;
    let lastByte: number | undefined;

    while (position < maxBytes) {
      const bytesToRead = Math.min(buffer.length, maxBytes - position);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead === 0) {
        break;
      }

      position += bytesRead;
      for (let index = 0; index < bytesRead; index += 1) {
        lastByte = buffer[index];
        if (lastByte === 0x0a) {
          lineCount += 1;
        }
      }
    }

    return {
      complete: position >= size,
      lines: lastByte !== undefined && lastByte !== 0x0a ? lineCount + 1 : lineCount,
    };
  } catch {
    return { complete: true, lines: 0 };
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export interface LargeUntrackedFileCheck {
  shouldSkip: boolean;
  stats?: DiffFile["stats"];
  statsTruncated?: boolean;
}

/** Return whether an untracked file is too large to synthesize into a full in-memory patch. */
export function inspectLargeUntrackedFile(
  repoRoot: string,
  filePath: string,
): LargeUntrackedFileCheck {
  const absolutePath = join(repoRoot, filePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return { shouldSkip: false };
  }

  const byteLimit =
    stat.size > LARGE_DIFF_FILE_MAX_BYTES ? LARGE_DIFF_FILE_MAX_BYTES : LARGE_DIFF_FILE_SNIFF_BYTES;
  const counted = countLinesInFile(absolutePath, byteLimit, stat.size);
  const shouldSkip =
    stat.size > LARGE_DIFF_FILE_MAX_BYTES || counted.lines > LARGE_DIFF_FILE_MAX_LINES;

  return {
    shouldSkip,
    stats: shouldSkip ? { additions: counted.lines, deletions: 0 } : undefined,
    statsTruncated: shouldSkip ? !counted.complete : undefined,
  };
}

/** Build a skipped placeholder for one untracked file that is too large to render. */
export function buildSkippedLargeUntrackedDiffFile(
  filePath: string,
  index: number,
  sourcePrefix: string,
  largeFileCheck: LargeUntrackedFileCheck,
) {
  return buildDiffFile(createSkippedLargeMetadata(filePath, "new"), "", index, sourcePrefix, null, {
    isTooLarge: true,
    isUntracked: true,
    stats: largeFileCheck.stats,
    statsTruncated: largeFileCheck.statsTruncated,
  });
}

/** Parse one synthetic untracked-file patch and reattach the real path after header normalization. */
export function parseUntrackedPatchFile(patchText: string, filePath: string) {
  let parsedPatches: ReturnType<typeof parsePatchFiles>;

  try {
    parsedPatches = parsePatchFiles(patchText, "patch", true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse untracked file patch for ${JSON.stringify(filePath)}: ${message}`,
    );
  }

  const metadataFiles = parsedPatches.flatMap((entry) => entry.files);
  if (metadataFiles.length !== 1) {
    throw new Error(
      `Expected one parsed file for untracked patch ${JSON.stringify(filePath)}, got ${metadataFiles.length}.`,
    );
  }

  const metadata = metadataFiles[0]!;
  return {
    ...metadata,
    name: filePath,
    prevName: undefined,
  } satisfies FileDiffMetadata;
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

  return buildDiffFile(parseUntrackedPatchFile(patch, filePath), patch, index, sourcePrefix, null, {
    isUntracked: true,
  });
}
