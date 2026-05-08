import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { stripGitLogMetadata } from "./loaders";

describe("stripGitLogMetadata", () => {
  test("returns input unchanged when no commit boundary is present", () => {
    const patch = [
      "diff --git a/foo b/foo",
      "index 0000000..1111111 100644",
      "--- a/foo",
      "+++ b/foo",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    expect(stripGitLogMetadata(patch)).toBe(patch);
  });

  test("strips a single commit's metadata header", () => {
    const input = [
      "commit 1a2b3c4d5e6f7890abcdef1234567890abcdef12",
      "Author: Someone <me@example.com>",
      "Date:   Tue Mar 3 12:00:00 2026 +0100",
      "",
      "    feat: do thing",
      "",
      "diff --git a/foo b/foo",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const expected = ["diff --git a/foo b/foo", "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n");

    expect(stripGitLogMetadata(input)).toBe(expected);
  });

  test("handles multiple commits in `git log -p` output", () => {
    const input = [
      "commit 1a2b3c4d5e6f7890abcdef1234567890abcdef12",
      "Author: A <a@x>",
      "Date:   Tue Mar 3 12:00:00 2026 +0100",
      "",
      "    first",
      "",
      "diff --git a/foo b/foo",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "",
      "commit aaaabbbbccccddddeeeeffff0000111122223333",
      "Author: B <b@x>",
      "Date:   Wed Mar 4 12:00:00 2026 +0100",
      "",
      "    second",
      "",
      "diff --git a/bar b/bar",
      "@@ -1,1 +1,1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");

    const expected = [
      "diff --git a/foo b/foo",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "",
      "diff --git a/bar b/bar",
      "@@ -1,1 +1,1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");

    expect(stripGitLogMetadata(input)).toBe(expected);
  });

  test("accepts decorated commit headers (refs in parens)", () => {
    const input = [
      "commit 1a2b3c4d5e6f7890abcdef1234567890abcdef12 (HEAD -> main, origin/main)",
      "Author: A <a@x>",
      "Date:   Tue Mar 3 12:00:00 2026 +0100",
      "",
      "    msg",
      "",
      "diff --git a/foo b/foo",
      "@@ -1,1 +1,1 @@",
      " ctx",
      "",
    ].join("\n");

    expect(stripGitLogMetadata(input)).toBe(
      ["diff --git a/foo b/foo", "@@ -1,1 +1,1 @@", " ctx", ""].join("\n"),
    );
  });

  test("accepts abbreviated SHAs (--abbrev)", () => {
    const input = [
      "commit 1a2b3c4",
      "Author: A <a@x>",
      "Date:   Tue Mar 3 12:00:00 2026 +0100",
      "",
      "    msg",
      "",
      "diff --git a/foo b/foo",
      "@@ -1,1 +1,1 @@",
      " ctx",
      "",
    ].join("\n");

    expect(stripGitLogMetadata(input)).toContain("diff --git a/foo b/foo");
    expect(stripGitLogMetadata(input)).not.toContain("commit 1a2b3c4");
    expect(stripGitLogMetadata(input)).not.toContain("Author:");
  });

  test("drops --stat blocks between header and patch (they aren't valid hunk lines)", () => {
    const input = [
      "commit 1a2b3c4d5e6f7890abcdef1234567890abcdef12",
      "Author: A <a@x>",
      "Date:   Tue Mar 3 12:00:00 2026 +0100",
      "",
      "    msg",
      "",
      " foo | 2 +-",
      " 1 file changed, 1 insertion(+), 1 deletion(-)",
      "",
      "diff --git a/foo b/foo",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const result = stripGitLogMetadata(input);
    expect(result).not.toContain("1 file changed");
    expect(result).not.toContain("foo | 2 +-");
    expect(result.startsWith("diff --git a/foo b/foo")).toBe(true);
  });

  test("drops merge-commit metadata", () => {
    const input = [
      "commit 1a2b3c4d5e6f7890abcdef1234567890abcdef12",
      "Merge: aaaaaaa bbbbbbb",
      "Author: A <a@x>",
      "Date:   Tue Mar 3 12:00:00 2026 +0100",
      "",
      "    Merge branch 'topic'",
      "",
      "diff --git a/foo b/foo",
      "@@ -1,1 +1,1 @@",
      " ctx",
      "",
    ].join("\n");

    const result = stripGitLogMetadata(input);
    expect(result).not.toContain("Merge:");
    expect(result.startsWith("diff --git a/foo b/foo")).toBe(true);
  });

  test("strips boundaries with SHA-256 (64-char) hashes", () => {
    // git init --object-format=sha256 emits 64-char hex SHAs.
    const sha256 = "a".repeat(64);
    const input = [
      `commit ${sha256}`,
      "Author: A <a@x>",
      "Date:   Tue Mar 3 12:00:00 2026 +0100",
      "",
      "    msg",
      "",
      "diff --git a/foo b/foo",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const result = stripGitLogMetadata(input);
    expect(result).not.toContain(`commit ${sha256}`);
    expect(result).not.toContain("Author:");
    expect(result.startsWith("diff --git a/foo b/foo")).toBe(true);
  });

  test("preserves context lines that mention the word 'commit'", () => {
    // A real hunk line that begins with a space-then-'commit' must NOT be
    // treated as a commit boundary — its leading space is the diff
    // line-type marker.
    const input = [
      "commit 1a2b3c4d5e6f7890abcdef1234567890abcdef12",
      "Author: A <a@x>",
      "Date:   Tue Mar 3 12:00:00 2026 +0100",
      "",
      "    msg",
      "",
      "diff --git a/foo b/foo",
      "@@ -1,2 +1,2 @@",
      " commit deadbeefcafebabe1234567890abcdef12345678 looks like a sha",
      "-old",
      "+new",
      "",
    ].join("\n");

    const result = stripGitLogMetadata(input);
    expect(result).toContain(" commit deadbeefcafebabe1234567890abcdef12345678 looks like a sha");
  });

  // Integration-style: real `git log -p`-shaped input should round-trip
  // through @pierre/diffs without triggering any
  // `parseLineType: Invalid firstChar` warnings, which is the bug this
  // helper exists to fix.
  test("stripped output parses via @pierre/diffs without parseLineType warnings", () => {
    const gitLogOutput = [
      "commit ed3dcb9406b1a169ef4740c858f6dff3dde146a0",
      "Author: t <t@t>",
      "Date:   Thu May 7 17:30:17 2026 +0200",
      "",
      "    update file",
      "",
      "diff --git a/file.txt b/file.txt",
      "index 9c59e24..e019be0 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +1 @@",
      "-first",
      "+second",
      "",
      "commit 2d037adaddaa53bbb9f037ba36a8e0ed57632f20",
      "Author: t <t@t>",
      "Date:   Thu May 7 17:30:17 2026 +0200",
      "",
      "    add file",
      "",
      "diff --git a/file.txt b/file.txt",
      "new file mode 100644",
      "index 0000000..9c59e24",
      "--- /dev/null",
      "+++ b/file.txt",
      "@@ -0,0 +1 @@",
      "+first",
      "",
    ].join("\n");

    const captured: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    };

    try {
      const stripped = stripGitLogMetadata(gitLogOutput);
      const parsed = parsePatchFiles(stripped, "patch", true);
      expect(parsed.flatMap((entry) => entry.files).length).toBe(2);
    } finally {
      console.error = originalError;
    }

    const noisy = captured.filter(
      (line) => line.includes("Invalid firstChar") || line.includes("invalid rawLine"),
    );
    expect(noisy).toEqual([]);
  });

  test("drops trailing commit with no diff (e.g. empty merge)", () => {
    const input = [
      "commit 1a2b3c4d5e6f7890abcdef1234567890abcdef12",
      "Author: A <a@x>",
      "Date:   Tue Mar 3 12:00:00 2026 +0100",
      "",
      "    diff-bearing commit",
      "",
      "diff --git a/foo b/foo",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "",
      "commit aaaabbbbccccddddeeeeffff0000111122223333",
      "Author: B <b@x>",
      "Date:   Wed Mar 4 12:00:00 2026 +0100",
      "",
      "    diff-less commit",
      "",
    ].join("\n");

    const result = stripGitLogMetadata(input);
    expect(result).toContain("diff --git a/foo b/foo");
    expect(result).not.toContain("diff-less commit");
    expect(result).not.toContain("aaaabbbb");
  });
});
