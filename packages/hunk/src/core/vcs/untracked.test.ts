import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFilesystemUntrackedDiffFile } from "./untracked";

const testDirectories: string[] = [];

/** Create one disposable repository root for filesystem-backed synthesis tests. */
function createTestRepoRoot() {
  const root = mkdtempSync(join(tmpdir(), "hunk-untracked-synthesis-"));
  testDirectories.push(root);
  return root;
}

afterEach(() => {
  while (testDirectories.length > 0) {
    rmSync(testDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("buildFilesystemUntrackedDiffFile", () => {
  test("keeps an empty untracked file as a zero-line addition", () => {
    const repoRoot = createTestRepoRoot();
    writeFileSync(join(repoRoot, "empty.txt"), "");

    const file = buildFilesystemUntrackedDiffFile(repoRoot, "empty.txt", 0, repoRoot);

    expect(file.metadata.type).toBe("new");
    expect(file.metadata.hunks).toHaveLength(0);
    expect(file.patch).toBe(
      [
        "diff --git a/empty.txt b/empty.txt",
        "new file mode 100644",
        "--- /dev/null\t",
        "+++ b/empty.txt",
        "",
      ].join("\n"),
    );
  });

  test("normalizes CRLF and marks a missing final newline", () => {
    const repoRoot = createTestRepoRoot();
    writeFileSync(join(repoRoot, "notes.txt"), "first\r\nsecond");

    const file = buildFilesystemUntrackedDiffFile(repoRoot, "notes.txt", 0, repoRoot);

    expect(file.patch).toContain("@@ -0,0 +1,2 @@\n+first\n+second\n");
    expect(file.patch).toEndWith("\\ No newline at end of file\n");
    expect(file.patch).not.toContain("\r");
  });

  test("does not mark newline-terminated contents as unterminated", () => {
    const repoRoot = createTestRepoRoot();
    writeFileSync(join(repoRoot, "notes.txt"), "first\r\nsecond\r\n");

    const file = buildFilesystemUntrackedDiffFile(repoRoot, "notes.txt", 0, repoRoot);

    expect(file.patch).toContain("@@ -0,0 +1,2 @@\n+first\n+second\n");
    expect(file.patch).not.toContain("No newline at end of file");
    expect(file.patch).not.toContain("\r");
  });
});
