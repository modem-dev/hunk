import fs from "node:fs";
import { join } from "node:path";

/**
 * Thresholds past which Hunk lists a file instead of rendering its diff.
 *
 * Shared by every backend so "too large to review" means one thing across the
 * product, and by the host's own untracked-file synthesizer.
 */
export const LARGE_DIFF_FILE_MAX_BYTES = 1_000_000;
export const LARGE_DIFF_FILE_MAX_LINES = 20_000;

/** How much of a file line counting reads before giving up and reporting a truncated count. */
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

export interface LargeFileCheck {
  shouldSkip: boolean;
  stats?: { additions: number; deletions: number };
  /** True when `stats` came from a capped read and undercount the real file. */
  statsTruncated?: boolean;
}

/**
 * Return whether a whole file on disk is too large to synthesize into a patch.
 *
 * Used for files that would be rendered from their current contents — untracked
 * files, and anything else a backend adds as a full-file addition — where the
 * cost is the file itself rather than the size of a change to it.
 */
export function inspectLargeUntrackedFile(repoRoot: string, filePath: string): LargeFileCheck {
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
