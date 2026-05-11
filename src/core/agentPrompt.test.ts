import { describe, expect, test } from "bun:test";
import { buildAgentPrompt, createAgentPromptFile, extractHunkPatch } from "./agentPrompt";
import { createTestDiffFile, lines } from "../../test/helpers/diff-helpers";

const patch = lines(
  "diff --git a/example.ts b/example.ts",
  "index 1111111..2222222 100644",
  "--- a/example.ts",
  "+++ b/example.ts",
  "@@ -1 +1 @@",
  "-const one = 1;",
  "+const one = 2;",
  "@@ -10 +10 @@",
  "-const ten = 10;",
  "+const ten = 11;",
);

describe("agent prompt export", () => {
  test("extracts one hunk with file headers from a raw patch", () => {
    expect(extractHunkPatch(patch, 1)).toBe(
      lines(
        "diff --git a/example.ts b/example.ts",
        "index 1111111..2222222 100644",
        "--- a/example.ts",
        "+++ b/example.ts",
        "@@ -10 +10 @@",
        "-const ten = 10;",
        "+const ten = 11;",
      ).trimEnd(),
    );
  });

  test("builds a paste-ready prompt with comment, selected text, and diff hunk", () => {
    const file = createTestDiffFile({
      before: "export const value = 1;\n",
      after: "export const value = 2;\n",
      path: "src/example.ts",
    });
    const prompt = buildAgentPrompt({
      title: "demo working tree",
      repoRoot: "/repo/demo",
      file: createAgentPromptFile({ ...file, patch }),
      hunkIndex: 0,
      selectedText: "export const value = 2;",
      comment: "Please make this configurable.",
    });

    expect(prompt).toContain("Please use this Hunk review context");
    expect(prompt).toContain("- Repo: /repo/demo");
    expect(prompt).toContain("- File: src/example.ts");
    expect(prompt).toContain("My comment:\nPlease make this configurable.");
    expect(prompt).toContain("Selected text from Hunk:\n```text\nexport const value = 2;\n```");
    expect(prompt).toContain("```diff\ndiff --git a/example.ts b/example.ts");
    expect(prompt).toContain("@@ -1 +1 @@");
  });

  test("falls back to the hunk header when raw patch text is unavailable", () => {
    const file = createTestDiffFile({ path: "src/example.ts" });
    const prompt = buildAgentPrompt({
      file: createAgentPromptFile(file),
      hunkIndex: 0,
    });

    expect(prompt).toContain("Diff hunk:");
    expect(prompt).toContain("@@");
  });
});
