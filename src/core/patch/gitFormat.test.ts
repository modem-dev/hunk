import { describe, expect, test } from "bun:test";
import { normalizeGitPatchPrefixes } from "./gitFormat";

/** Build a one-file `diff --git` block with the given header and body lines. */
function patch(...lines: string[]) {
  return lines.join("\n");
}

describe("normalizeGitPatchPrefixes", () => {
  test("returns text untouched when it contains no git header", () => {
    const text = "hello\nworld\n--- not a real header";
    expect(normalizeGitPatchPrefixes(text)).toBe(text);
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
    expect(normalizeGitPatchPrefixes(input)).toBe(input);
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
    expect(normalizeGitPatchPrefixes(input)).toBe(
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
    expect(normalizeGitPatchPrefixes(input)).toBe(
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
    expect(normalizeGitPatchPrefixes(input)).toBe(
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
    expect(normalizeGitPatchPrefixes(input)).toBe(
      patch("diff --git a/foo bar.ts b/foo bar.ts", "--- a/foo bar.ts", "+++ b/foo bar.ts"),
    );
  });

  test("adds prefixes to quoted noprefix paths containing spaces", () => {
    const input = patch('diff --git "foo bar.ts" "foo bar.ts"', "--- foo bar.ts", "+++ foo bar.ts");
    expect(normalizeGitPatchPrefixes(input)).toBe(
      patch("diff --git a/foo bar.ts b/foo bar.ts", "--- a/foo bar.ts", "+++ b/foo bar.ts"),
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
    expect(normalizeGitPatchPrefixes(input)).toBe(
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
    expect(normalizeGitPatchPrefixes(input)).toBe(
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
    expect(normalizeGitPatchPrefixes(input)).toBe(
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
