import { describe, expect, test } from "bun:test";
import type { FileDiffMetadata } from "@pierre/diffs";
import { findPatchChunk, splitPatchIntoFileChunks } from "./chunks";

function createMetadata(name?: string, prevName?: string): FileDiffMetadata {
  return { name, prevName } as FileDiffMetadata;
}

describe("patch chunk helpers", () => {
  // Intent: non-git unified diffs still split into stable per-file chunks.
  test("splits plain unified multi-file patches without git headers", () => {
    const chunks = splitPatchIntoFileChunks(
      [
        "--- a/alpha.txt",
        "+++ b/alpha.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "--- a/beta.txt",
        "+++ b/beta.txt",
        "@@ -1 +1 @@",
        "-left",
        "+right",
        "",
      ].join("\n"),
    );

    expect(chunks).toEqual([
      "--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1 +1 @@\n-old\n+new\n",
      "--- a/beta.txt\n+++ b/beta.txt\n@@ -1 +1 @@\n-left\n+right\n",
    ]);
  });

  // Intent: fallback matching works by current or previous path when index lookup misses.
  test("matches fallback chunks by normalized current or previous path", () => {
    const chunks = [
      "diff --git a/old-name.ts b/new-name.ts\n--- a/old-name.ts\n+++ b/new-name.ts\n",
    ];

    expect(findPatchChunk(createMetadata("b/new-name.ts"), chunks, 3)).toBe(chunks[0]!);
    expect(findPatchChunk(createMetadata(undefined, "a/old-name.ts"), chunks, 3)).toBe(chunks[0]!);
  });

  // Intent: unmatched metadata returns an empty patch instead of a misleading chunk.
  test("returns an empty chunk when neither index nor path matches", () => {
    expect(
      findPatchChunk(createMetadata("missing.ts"), ["diff --git a/other.ts b/other.ts\n"], 2),
    ).toBe("");
  });
});
