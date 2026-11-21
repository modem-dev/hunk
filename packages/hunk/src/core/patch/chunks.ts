import type { FileDiffMetadata } from "@pierre/diffs";
import { normalizeDiffPath } from "../changeset/diffPaths";

/** Remove git-style a/ and b/ prefixes before matching diff paths. */
function stripPrefixes(path: string) {
  return path.replace(/^[ab]\//, "");
}

/** Read the old/new line counts a unified-diff hunk header promises, or null for other lines. */
function readHunkLineCounts(line: string) {
  const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return null;
  }

  return { old: Number(match[1] ?? 1), new: Number(match[2] ?? 1) };
}

/**
 * Report whether a `--- ` / `+++ ` / `@@` run inside an open hunk is the next file's header.
 *
 * A well-formed hunk can end with a removed `-- x` and added `++ y` line followed by the same
 * file's next `@@` hunk, so the run counts as body when those two lines exactly use up the open
 * hunk. When lines would still be owed afterwards, the `@@` line cannot be hunk body, so the
 * hunk header over-promised and the run starts a new file. The remaining ambiguity is an
 * over-promising hunk that owes exactly one old and one new line before the next file header;
 * that run stays with the open file, matching the well-formed reading.
 */
function isOverPromisedFileHeader(
  lines: string[],
  index: number,
  oldLinesLeft: number,
  newLinesLeft: number,
) {
  if (
    !lines[index]!.startsWith("--- ") ||
    !lines[index + 1]?.startsWith("+++ ") ||
    !readHunkLineCounts(lines[index + 2] ?? "")
  ) {
    return false;
  }

  return oldLinesLeft !== 1 || newLinesLeft !== 1;
}

/** Split a multi-file patch into per-file chunks so each diff file keeps its original patch text. */
export function splitPatchIntoFileChunks(rawPatch: string) {
  const patch = rawPatch.replaceAll("\r\n", "\n");
  const lines = patch.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  const hasGitHeaders = lines.some((line) => line.startsWith("diff --git "));
  // Lines still owed to the open hunk. Without `diff --git` boundaries, a removed `-- x` line
  // followed by an added `++ y` line reads as `--- x` / `+++ y`, so file headers are only
  // recognized once the hunk header's counts are used up or the header over-promised them.
  let oldLinesLeft = 0;
  let newLinesLeft = 0;

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

    if (
      !hasGitHeaders &&
      (oldLinesLeft > 0 || newLinesLeft > 0) &&
      !isOverPromisedFileHeader(lines, index, oldLinesLeft, newLinesLeft)
    ) {
      const marker = line[0];
      const isContext = marker === " " || marker === undefined;
      if (
        (marker === "-" && oldLinesLeft > 0) ||
        (marker === "+" && newLinesLeft > 0) ||
        (isContext && oldLinesLeft > 0 && newLinesLeft > 0)
      ) {
        if (marker !== "+") {
          oldLinesLeft -= 1;
        }

        if (marker !== "-") {
          newLinesLeft -= 1;
        }

        current.push(line);
        continue;
      }

      if (marker === "\\") {
        current.push(line);
        continue;
      }

      // Not a hunk body line, so the header over-promised: resume normal header detection.
      oldLinesLeft = 0;
      newLinesLeft = 0;
    }

    if (!hasGitHeaders && line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      flush();
      current.push(line);
      current.push(lines[index + 1]!);
      index += 1;
      // A new file ends any hunk whose header over-promised its line counts.
      oldLinesLeft = 0;
      newLinesLeft = 0;
      continue;
    }

    if (!hasGitHeaders && current.length > 0) {
      const counts = readHunkLineCounts(line);
      if (counts) {
        oldLinesLeft = counts.old;
        newLinesLeft = counts.new;
      }
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  flush();
  return chunks;
}

/** Recover the original patch chunk for one parsed file, preferring index order before path matching. */
export function findPatchChunk(metadata: FileDiffMetadata, chunks: string[], index: number) {
  const byIndex = chunks[index];
  if (byIndex) {
    return byIndex;
  }

  return (
    chunks.find((chunk) =>
      [metadata.name, metadata.prevName]
        .map(normalizeDiffPath)
        .filter((value): value is string => Boolean(value))
        .map(stripPrefixes)
        .some(
          (path) =>
            chunk.includes(`a/${path}`) || chunk.includes(`b/${path}`) || chunk.includes(path),
        ),
    ) ?? ""
  );
}
