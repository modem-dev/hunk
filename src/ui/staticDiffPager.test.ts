import { describe, expect, test } from "bun:test";
import { renderStaticDiffPager } from "./staticDiffPager";

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("static diff pager", () => {
  test("renders diff-like stdin as non-interactive ANSI output", async () => {
    const patchText =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n";

    const output = await renderStaticDiffPager(patchText);

    const plain = stripAnsi(output);

    expect(plain).toContain("a.ts modified +1 -1");
    expect(plain).toContain("▌@@ -1 +1 @@\n");
    expect(plain).toContain("▌1   -  const value = 1;");
    expect(plain).toContain("▌  1 +  const value = 2;");
    expect(output).toContain("\x1b[38;2;");
    expect(output).not.toContain("\x1b[?1049h");
  });

  test("honors configured hidden line numbers and hunk headers", async () => {
    const patchText =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n";

    const plain = stripAnsi(
      await renderStaticDiffPager(patchText, { lineNumbers: false, hunkHeaders: false }),
    );

    expect(plain).not.toContain("@@ -1 +1 @@");
    expect(plain).toContain("▌- const value = 1;");
    expect(plain).toContain("▌+ const value = 2;");
  });

  test("shows semantic file metadata without raw patch headers", async () => {
    const patchText = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..587be6b",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");

    const plain = stripAnsi(await renderStaticDiffPager(patchText));

    expect(plain).toContain("new.txt new file 100644 +1 -0");
    expect(plain).not.toContain("diff --git");
    expect(plain).not.toContain("index 0000000");
  });

  test("falls back to original text with a diagnostic when the patch cannot be parsed", async () => {
    const text = "diff --git incomplete\n";
    let warning = "";

    await expect(
      renderStaticDiffPager(
        text,
        {},
        {
          stderr: {
            write: (chunk) => {
              warning += String(chunk);
              return true;
            },
          },
        },
      ),
    ).resolves.toBe(text);
    expect(warning).toContain("hunk: static pager render failed");
    expect(warning).toContain("falling back to raw diff");
  });
});
