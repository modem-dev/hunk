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

  // Intent: hunk body lines that merely look like file headers stay with their own file.
  test("keeps removed -- and added ++ lines inside plain unified hunks", () => {
    const chunks = splitPatchIntoFileChunks(
      [
        "--- a/schema.sql",
        "+++ b/schema.sql",
        "@@ -1,3 +1,3 @@",
        " select 1;",
        "--- old comment",
        "+++ new comment",
        " select 2;",
        "--- a/beta.txt",
        "+++ b/beta.txt",
        "@@ -1 +1 @@",
        "-left",
        "+right",
        "",
      ].join("\n"),
    );

    expect(chunks).toEqual([
      "--- a/schema.sql\n+++ b/schema.sql\n@@ -1,3 +1,3 @@\n select 1;\n--- old comment\n+++ new comment\n select 2;\n",
      "--- a/beta.txt\n+++ b/beta.txt\n@@ -1 +1 @@\n-left\n+right\n",
    ]);
  });

  // Intent: a hunk header that over-promises its counts does not swallow the next file.
  test("starts the next plain unified file when a hunk header over-promises its counts", () => {
    const chunks = splitPatchIntoFileChunks(
      [
        "--- a/alpha.txt",
        "+++ b/alpha.txt",
        "@@ -1,5 +1,5 @@",
        "-left",
        "+right",
        "--- a/beta.txt",
        "+++ b/beta.txt",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );

    expect(chunks).toEqual([
      "--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1,5 +1,5 @@\n-left\n+right\n",
      "--- a/beta.txt\n+++ b/beta.txt\n@@ -1 +1 @@\n-old\n+new\n",
    ]);
  });

  // Intent: header-like body lines that end a hunk stay with the file's next hunk.
  test("keeps -- and ++ lines that end a plain unified hunk before the next hunk", () => {
    const chunks = splitPatchIntoFileChunks(
      [
        "--- a/schema.sql",
        "+++ b/schema.sql",
        "@@ -1,2 +1,2 @@",
        " select 1;",
        "--- old comment",
        "+++ new comment",
        "@@ -9 +9 @@",
        "-select 2;",
        "+select 3;",
        "",
      ].join("\n"),
    );

    expect(chunks).toEqual([
      "--- a/schema.sql\n+++ b/schema.sql\n@@ -1,2 +1,2 @@\n select 1;\n--- old comment\n+++ new comment\n@@ -9 +9 @@\n-select 2;\n+select 3;\n",
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
