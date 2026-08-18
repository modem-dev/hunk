import fs from "node:fs";
import { join } from "node:path";
import { createSkippedBinaryMetadata, isProbablyBinaryFile } from "../changeset/binary";
import { buildDiffFile, createSkippedLargeMetadata } from "../changeset/diffFile";
import { createFileSourceFetcher } from "../changeset/fileSource";
import { inspectLargeUntrackedFile } from "../../lib/largeFile";
import { escapeUntrackedPatchPath } from "../../lib/patchPath";
import { parseSingleFilePatch } from "../patch/singleFile";
import type { LargeFileCheck } from "../../lib/largeFile";

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

/** Build the linear added-file patch every patch consumer parses. */
function buildUntrackedPatchText(safePath: string, mode: string, contents: string) {
  const normalizedContents = contents.replaceAll("\r\n", "\n");
  const endsWithNewline = normalizedContents.endsWith("\n");
  const lines = normalizedContents === "" ? [] : normalizedContents.split("\n");
  if (endsWithNewline) {
    lines.pop();
  }

  const patch = [
    `diff --git a/${safePath} b/${safePath}`,
    `new file mode ${mode}`,
    "--- /dev/null\t",
    `+++ b/${safePath}`,
  ];
  if (lines.length > 0) {
    patch.push(`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`));
    if (!endsWithNewline) {
      patch.push("\\ No newline at end of file");
    }
  }

  // A new file has no matching lines to diff, so direct linear synthesis avoids
  // generic LCS work while preserving jsdiff's normalized patch shape.
  return `${patch.join("\n")}\n`;
}

/** Build one filesystem-backed untracked file diff from its current contents. */
export function buildFilesystemUntrackedDiffFile(
  repoRoot: string,
  filePath: string,
  index: number,
  sourcePrefix: string,
) {
  const absolutePath = join(repoRoot, filePath);
  const safePath = escapeUntrackedPatchPath(filePath);

  // Diff a symlink as Git does — mode 120000 whose one line is the link target —
  // instead of dereferencing it. This also keeps dangling symlinks reviewable
  // rather than failing the whole load on the missing target.
  let linkTarget: string | null = null;
  try {
    if (fs.lstatSync(absolutePath).isSymbolicLink()) {
      linkTarget = fs.readlinkSync(absolutePath);
    }
  } catch {
    // A path that vanished after being listed falls through to the regular
    // read below, which surfaces the same missing-file error as before.
  }
  if (linkTarget !== null) {
    const patch = buildUntrackedPatchText(safePath, "120000", linkTarget);
    // No source fetcher: reading the path would dereference the link, and the
    // patch already carries the only content a symlink has.
    return buildDiffFile(parseSingleFilePatch(patch, filePath), patch, index, sourcePrefix, null, {
      isUntracked: true,
    });
  }

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

  // Git records exactly two regular-file modes: 100755 when any execute bit
  // is set, 100644 otherwise.
  let mode = "100644";
  try {
    if (fs.statSync(absolutePath).mode & 0o111) {
      mode = "100755";
    }
  } catch {
    // A vanished path surfaces its missing-file error from the read below.
  }
  const patch = buildUntrackedPatchText(safePath, mode, fs.readFileSync(absolutePath, "utf8"));

  return buildDiffFile(parseSingleFilePatch(patch, filePath), patch, index, sourcePrefix, null, {
    isUntracked: true,
    // An added file has no old side; the new side reads the working copy so
    // source-backed features treat synthesized untracked files like any other.
    sourceFetcherBuilder: (file) =>
      file.isBinary
        ? undefined
        : createFileSourceFetcher({
            old: { kind: "none" },
            new: { kind: "fs", absolutePath },
          }),
  });
}
