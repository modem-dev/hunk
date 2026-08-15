import { describe, expect, test } from "bun:test";
import { sanitizeGitPatch, sanitizeGitPatchText } from "./gitFormat";

/** Build a one-file `diff --git` block with the given header and body lines. */
function patch(...lines: string[]) {
  return lines.join("\n");
}

describe("sanitizeGitPatchText", () => {
  test("returns text untouched when it contains no git header", () => {
    const text = "hello\nworld\n--- not a real header";
    expect(sanitizeGitPatchText(text)).toBe(text);
  });

  test("leaves already-canonical a/ b/ headers unchanged", () => {
    const input = patch(
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    );
    expect(sanitizeGitPatchText(input)).toBe(input);
  });

  test("adds a/ b/ prefixes to a noprefix non-rename block", () => {
    const input = patch(
      "diff --git foo.ts foo.ts",
      "--- foo.ts",
      "+++ foo.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    );
    expect(sanitizeGitPatchText(input)).toBe(
      patch(
        "diff --git a/foo.ts b/foo.ts",
        "--- a/foo.ts",
        "+++ b/foo.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );
  });

  test("rewrites mnemonic-prefixed paths into canonical a/ b/ form", () => {
    const input = patch(
      "diff --git i/foo.ts w/foo.ts",
      "--- i/foo.ts",
      "+++ w/foo.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    );
    expect(sanitizeGitPatchText(input)).toBe(
      patch(
        "diff --git a/foo.ts b/foo.ts",
        "--- a/foo.ts",
        "+++ b/foo.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );
  });

  test("adds prefixes to a two-token noprefix rename and updates its file headers", () => {
    const input = patch(
      "diff --git old.ts new.ts",
      "rename from old.ts",
      "rename to new.ts",
      "--- old.ts",
      "+++ new.ts",
    );
    expect(sanitizeGitPatchText(input)).toBe(
      patch(
        "diff --git a/old.ts b/new.ts",
        "rename from old.ts",
        "rename to new.ts",
        "--- a/old.ts",
        "+++ b/new.ts",
      ),
    );
  });

  test("unquotes already-prefixed quoted paths into Pierre's unquoted form", () => {
    const input = patch(
      'diff --git "a/foo bar.ts" "b/foo bar.ts"',
      '--- "a/foo bar.ts"',
      '+++ "b/foo bar.ts"',
    );
    expect(sanitizeGitPatchText(input)).toBe(
      patch("diff --git a/foo bar.ts b/foo bar.ts", "--- a/foo bar.ts", "+++ b/foo bar.ts"),
    );
  });

  test("adds prefixes to quoted noprefix paths containing spaces", () => {
    const input = patch('diff --git "foo bar.ts" "foo bar.ts"', "--- foo bar.ts", "+++ foo bar.ts");
    expect(sanitizeGitPatchText(input)).toBe(
      patch("diff --git a/foo bar.ts b/foo bar.ts", "--- a/foo bar.ts", "+++ b/foo bar.ts"),
    );
  });

  test("decodes Git-quoted UTF-8 octets in diff and unified headers", () => {
    const escapedPath = String.raw`\345\233\275\351\232\233\345\214\226/\346\227\245\346\234\254\350\252\236-\353\263\200\352\262\275-\360\237\247\252.txt`;
    const input = patch(
      `diff --git "a/${escapedPath}" "b/${escapedPath}"`,
      `--- "a/${escapedPath}"`,
      `+++ "b/${escapedPath}"`,
    );

    expect(sanitizeGitPatchText(input)).toBe(
      patch(
        "diff --git a/国際化/日本語-변경-🧪.txt b/国際化/日本語-변경-🧪.txt",
        "--- a/国際化/日本語-변경-🧪.txt",
        "+++ b/国際化/日本語-변경-🧪.txt",
      ),
    );
  });

  test("decodes Git-quoted UTF-8 octets in rename metadata", () => {
    const escapedOldPath = String.raw`\346\227\245\346\234\254\350\252\236.txt`;
    const escapedNewPath = String.raw`\355\225\234\352\265\255\354\226\264\360\237\247\252.txt`;
    const input = patch(
      `diff --git "a/${escapedOldPath}" "b/${escapedNewPath}"`,
      "similarity index 100%",
      `rename from "${escapedOldPath}"`,
      `rename to "${escapedNewPath}"`,
    );

    expect(sanitizeGitPatchText(input)).toBe(
      patch(
        "diff --git a/日本語.txt b/한국어🧪.txt",
        "similarity index 100%",
        "rename from 日本語.txt",
        "rename to 한국어🧪.txt",
      ),
    );
  });

  test("preserves a real top-level a directory in quoted noprefix paths", () => {
    const path = String.raw`a/tab\t.txt`;
    const normalized = sanitizeGitPatch(
      patch(`diff --git "${path}" "${path}"`, `--- "${path}"`, `+++ "${path}"`),
    );

    expect(normalized.text).toBe(
      patch(
        String.raw`diff --git a/a/tab\t.txt b/a/tab\t.txt`,
        String.raw`--- a/a/tab\t.txt`,
        String.raw`+++ b/a/tab\t.txt`,
      ),
    );
    expect(normalized.filePaths).toEqual([{ path: "a/tab\t.txt" }]);
  });

  test("uses copy metadata to preserve real mnemonic-looking directories", () => {
    const escapedOldPath = String.raw`i/\346\227\245\346\234\254\350\252\236.txt`;
    const escapedNewPath = String.raw`w/\355\225\234\352\265\255\354\226\264.txt`;
    const normalized = sanitizeGitPatch(
      patch(
        `diff --git "${escapedOldPath}" "${escapedNewPath}"`,
        "similarity index 100%",
        `copy from "${escapedOldPath}"`,
        `copy to "${escapedNewPath}"`,
      ),
    );

    expect(normalized.text).toBe(
      patch(
        "diff --git a/i/日本語.txt b/w/한국어.txt",
        "similarity index 100%",
        "copy from i/日本語.txt",
        "copy to w/한국어.txt",
      ),
    );
    expect(normalized.filePaths).toEqual([{ path: "w/한국어.txt", previousPath: "i/日本語.txt" }]);
  });

  test("retains exact C-style decoded paths beside parser-safe patch text", () => {
    const escapedPath = String.raw`a/\345\233\275\351\232\233\345\214\226/tab\tquote\"back\\\360\237\247\252.txt`;
    const normalized = sanitizeGitPatch(
      patch(
        `diff --git "${escapedPath}" "${escapedPath.replace("a/", "b/")}"`,
        `--- "${escapedPath}"`,
        `+++ "${escapedPath.replace("a/", "b/")}"`,
      ),
    );

    expect(normalized.text).toContain(`${String.raw`tab\tquote\"back\\`}🧪.txt`);
    expect(normalized.filePaths).toEqual([{ path: '国際化/tab\tquote"back\\🧪.txt' }]);
  });

  test("keeps decoded path metadata aligned across multiple file blocks", () => {
    const firstPath = String.raw`\346\227\245\346\234\254\350\252\236.txt`;
    const secondPath = String.raw`\355\225\234\352\265\255\354\226\264.txt`;
    const normalized = sanitizeGitPatch(
      patch(
        `diff --git "a/${firstPath}" "b/${firstPath}"`,
        `--- "a/${firstPath}"`,
        `+++ "b/${firstPath}"`,
        "@@ -1 +1 @@",
        "-one",
        "+two",
        `diff --git "a/${secondPath}" "b/${secondPath}"`,
        `--- "a/${secondPath}"`,
        `+++ "b/${secondPath}"`,
        "@@ -1 +1 @@",
        "-three",
        "+four",
      ),
    );

    expect(normalized.filePaths).toEqual([{ path: "日本語.txt" }, { path: "한국어.txt" }]);
  });

  test("preserves non-UTF-8 octets and protected literal backslashes", () => {
    const invalidPath = String.raw`a/bad\377-overflow\433-csi\302\233-name\\345.txt`;
    const input = patch(
      `diff --git "${invalidPath}" "${invalidPath.replace("a/", "b/")}"`,
      `--- "${invalidPath}"`,
      `+++ "${invalidPath.replace("a/", "b/")}"`,
    );

    expect(sanitizeGitPatchText(input)).toBe(
      patch(
        String.raw`diff --git a/bad\377-overflow\433-csi\302\233-name\\345.txt b/bad\377-overflow\433-csi\302\233-name\\345.txt`,
        String.raw`--- a/bad\377-overflow\433-csi\302\233-name\\345.txt`,
        String.raw`+++ b/bad\377-overflow\433-csi\302\233-name\\345.txt`,
      ),
    );
  });

  test("never rewrites hunk-body lines that merely look like file headers", () => {
    const input = patch(
      "diff --git foo.ts foo.ts",
      "--- foo.ts",
      "+++ foo.ts",
      "@@ -1 +1 @@",
      "-diff --git x y",
      "+changed",
    );
    expect(sanitizeGitPatchText(input)).toBe(
      patch(
        "diff --git a/foo.ts b/foo.ts",
        "--- a/foo.ts",
        "+++ b/foo.ts",
        "@@ -1 +1 @@",
        // The deletion line is body content and must survive verbatim.
        "-diff --git x y",
        "+changed",
      ),
    );
  });

  test("preserves /dev/null file headers when prefixing a new file", () => {
    const input = patch(
      "diff --git new.ts new.ts",
      "--- /dev/null",
      "+++ new.ts",
      "@@ -0,0 +1 @@",
      "+a",
    );
    expect(sanitizeGitPatchText(input)).toBe(
      patch("diff --git a/new.ts b/new.ts", "--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1 @@", "+a"),
    );
  });

  test("normalizes every block in a multi-file patch independently", () => {
    const input = patch(
      "diff --git one.ts one.ts",
      "--- one.ts",
      "+++ one.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/two.ts b/two.ts",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -1 +1 @@",
      "-p",
      "+q",
    );
    expect(sanitizeGitPatchText(input)).toBe(
      patch(
        "diff --git a/one.ts b/one.ts",
        "--- a/one.ts",
        "+++ b/one.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "diff --git a/two.ts b/two.ts",
        "--- a/two.ts",
        "+++ b/two.ts",
        "@@ -1 +1 @@",
        "-p",
        "+q",
      ),
    );
  });
});
