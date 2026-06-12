import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffFile } from "./types";

/**
 * Identity helpers for the "mark hunk as reviewed" feature.
 *
 * A reviewed hunk is identified by a fast content hash over:
 * - the file path,
 * - the hunk's occurrence index among byte-identical hunk bodies in the same
 *   file (0 for unique hunks, so unique hunks behave as pure content hashes),
 * - the hunk body lines (sign-prefixed context/deletion/addition content).
 *
 * The `@@` hunk header is deliberately excluded: it embeds absolute line
 * numbers, so including it would un-review every hunk below an unrelated edit.
 */

/** Minimal slice of DiffFile needed to compute reviewed-hunk hashes. */
export type ReviewedHashSource = Pick<DiffFile, "path" | "metadata">;

/**
 * Reconstruct the signed body lines of one hunk, excluding the `@@` header.
 *
 * Lines are prefixed with their diff sign (`" "`, `"-"`, `"+"`) so that the
 * same text appearing as context vs. change cannot collide. Context lines are
 * read from the addition side; both sides hold identical text for context.
 * Pierre keeps each line's trailing newline, so trailing-newline-only changes
 * still alter the body (and therefore the hash).
 */
export function hunkBodyLines(metadata: FileDiffMetadata, hunkIndex: number): string[] {
  const hunk = metadata.hunks[hunkIndex];
  if (!hunk) {
    return [];
  }

  const body: string[] = [];
  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      for (let offset = 0; offset < content.lines; offset += 1) {
        body.push(` ${metadata.additionLines[content.additionLineIndex + offset] ?? ""}`);
      }
      continue;
    }

    // Match unified-diff order: deletions before additions within a change run.
    for (let offset = 0; offset < content.deletions; offset += 1) {
      body.push(`-${metadata.deletionLines[content.deletionLineIndex + offset] ?? ""}`);
    }
    for (let offset = 0; offset < content.additions; offset += 1) {
      body.push(`+${metadata.additionLines[content.additionLineIndex + offset] ?? ""}`);
    }
  }

  return body;
}

/** Count of body lines hidden when one hunk collapses to a reviewed marker. */
export function hunkBodyLineCount(metadata: FileDiffMetadata, hunkIndex: number): number {
  const hunk = metadata.hunks[hunkIndex];
  if (!hunk) {
    return 0;
  }

  let count = 0;
  for (const content of hunk.hunkContent) {
    count += content.type === "context" ? content.lines : content.deletions + content.additions;
  }
  return count;
}

interface CachedFileHashes {
  path: string;
  hashes: readonly string[];
}

// Keyed on `metadata` (not DiffFile): review-state rebuilds clone DiffFiles
// but keep the same metadata reference, while reloads produce new metadata.
const FILE_HASH_CACHE = new WeakMap<FileDiffMetadata, CachedFileHashes>();

/** Hash one path + occurrence + body tuple into a filename-safe hex string. */
function hashReviewedHunk(path: string, occurrenceIndex: number, body: string): string {
  // NUL separators keep path/index/body unambiguous (paths may contain spaces).
  const input = `${path}\0${occurrenceIndex}\0${body}`;
  return Bun.hash.wyhash(input).toString(16).padStart(16, "0");
}

/**
 * All reviewed-hunk hashes for one file, in hunk order.
 *
 * Computed in a single pass so occurrence indexes among byte-identical hunk
 * bodies stay consistent; cached per `metadata` identity.
 */
export function fileReviewedHunkHashes(file: ReviewedHashSource): readonly string[] {
  const cached = FILE_HASH_CACHE.get(file.metadata);
  if (cached && cached.path === file.path) {
    return cached.hashes;
  }

  const occurrenceByBody = new Map<string, number>();
  const hashes = file.metadata.hunks.map((_, hunkIndex) => {
    // Lines already carry their newlines; plain concatenation is the body text.
    const body = hunkBodyLines(file.metadata, hunkIndex).join("");
    const occurrenceIndex = occurrenceByBody.get(body) ?? 0;
    occurrenceByBody.set(body, occurrenceIndex + 1);
    return hashReviewedHunk(file.path, occurrenceIndex, body);
  });

  FILE_HASH_CACHE.set(file.metadata, { path: file.path, hashes });
  return hashes;
}

/** Stable content hash for one hunk of one file. */
export function reviewedHunkHash(file: ReviewedHashSource, hunkIndex: number): string | undefined {
  return fileReviewedHunkHashes(file)[hunkIndex];
}

/** Resolve which hunk indices of one file are present in a reviewed-hash set. */
export function resolveReviewedHunkIndices(
  file: ReviewedHashSource,
  reviewedHashes: ReadonlySet<string>,
): ReadonlySet<number> {
  const indices = new Set<number>();
  if (reviewedHashes.size === 0) {
    return indices;
  }

  fileReviewedHunkHashes(file).forEach((hash, hunkIndex) => {
    if (reviewedHashes.has(hash)) {
      indices.add(hunkIndex);
    }
  });
  return indices;
}
