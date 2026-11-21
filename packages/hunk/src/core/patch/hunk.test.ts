import { describe, expect, test } from "bun:test";
import { extractHunk } from "./hunk";

const FILE_PATCH = [
  "diff --git a/alpha.ts b/alpha.ts",
  "index 1111111..2222222 100644",
  "--- a/alpha.ts",
  "+++ b/alpha.ts",
  "@@ -1,3 +1,3 @@ first",
  " keep",
  "-old one",
  "+new one",
  "@@ -10,2 +10,3 @@ second",
  " context",
  "+added",
  "-removed",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("extractHunk", () => {
  // Intent: a copied hunk is exactly its `@@` header and body, without the file header.
  test("returns only the requested hunk", () => {
    expect(extractHunk(FILE_PATCH, 0)).toBe(
      ["@@ -1,3 +1,3 @@ first", " keep", "-old one", "+new one", ""].join("\n"),
    );
  });

  // Intent: the last hunk keeps its raw trailing markers verbatim.
  test("keeps no-newline markers on the last hunk", () => {
    expect(extractHunk(FILE_PATCH, 1)).toBe(
      [
        "@@ -10,2 +10,3 @@ second",
        " context",
        "+added",
        "-removed",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  // Intent: out-of-range selections and hunkless patches copy nothing.
  test("returns undefined when the hunk does not exist", () => {
    expect(extractHunk(FILE_PATCH, 2)).toBeUndefined();
    expect(extractHunk(FILE_PATCH, -1)).toBeUndefined();
    expect(extractHunk("", 0)).toBeUndefined();
    expect(extractHunk("diff --git a/a.png b/a.png\nBinary files differ\n", 0)).toBeUndefined();
  });
});
