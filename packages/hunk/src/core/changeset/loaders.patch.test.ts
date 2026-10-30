import { describe, expect, test } from "bun:test";
import { loadAppBootstrap } from "./loaders";

const textPatch =
  "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n";

/** Load explicit patch text through the same input boundary as files and stdin. */
function loadTestPatch(text: string) {
  return loadAppBootstrap({ kind: "patch", text, options: {} });
}

describe("explicit patch input validation", () => {
  test.each(["not a patch\n", "error: upstream command failed\n", "diff --git\n"])(
    "rejects nonempty input without any recognized files (%s)",
    async (text) => {
      await expect(loadTestPatch(text)).rejects.toThrow(
        "No recognizable file changes in patch input",
      );
    },
  );

  test.each(["", " \n\t\r\n"])("preserves intentionally empty input (%s)", async (text) => {
    expect((await loadTestPatch(text)).changeset.files).toHaveLength(0);
  });

  test.each([
    ["unified", textPatch],
    ["traditional", "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n"],
    [
      "mail envelope",
      "From 0123456789 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] Update\n\n" +
        textPatch +
        "-- \n2.50.0\n",
    ],
    ["mode only", "diff --git a/a.txt b/a.txt\nold mode 100644\nnew mode 100755\n"],
    [
      "rename only",
      "diff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt\n",
    ],
    [
      "empty added file",
      "diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n",
    ],
    [
      "binary",
      "diff --git a/a.bin b/a.bin\nindex 1234567..7654321 100644\nBinary files a/a.bin and b/a.bin differ\n",
    ],
    [
      "ANSI colored",
      textPatch
        .replace("-before", "\u001b[31m-before\u001b[0m")
        .replace("+after", "\u001b[32m+after\u001b[0m"),
    ],
  ])("preserves supported %s patches", async (_name, text) => {
    expect((await loadTestPatch(text)).changeset.files).toHaveLength(1);
  });
});
