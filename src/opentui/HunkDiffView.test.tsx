import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { ReactNode } from "react";
import {
  HUNK_DIFF_THEME_NAMES,
  HunkDiffBody,
  HunkDiffFileHeader,
  HunkDiffView,
  HunkFileNav,
  HunkReviewStream,
  createHunkDiffFile,
  createHunkDiffFilesFromPatch,
  parseDiffFromFile,
} from "./index";

async function captureFrame(node: ReactNode, width = 120, height = 24) {
  const setup = await testRender(node, { width, height });

  try {
    await act(async () => {
      await setup.renderOnce();
    });

    return setup.captureCharFrame();
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

function createExampleDiff() {
  const metadata = parseDiffFromFile(
    {
      cacheKey: "before",
      contents: "export const value = 1;\n",
      name: "example.ts",
    },
    {
      cacheKey: "after",
      contents: "export const value = 2;\nexport const added = true;\n",
      name: "example.ts",
    },
    { context: 3 },
    true,
  );

  return createHunkDiffFile({
    id: "example",
    language: "typescript",
    metadata,
    path: "example.ts",
  });
}

describe("OpenTUI public components", () => {
  test("renders a diff through the public OpenTUI entrypoint", async () => {
    const frame = await captureFrame(
      <HunkDiffView
        diff={createExampleDiff()}
        layout="split"
        theme="github-dark-default"
        width={88}
        scrollable={false}
      />,
      92,
      12,
    );

    expect(frame).toContain("@@ -1,1 +1,2 @@");
    expect(frame).toContain("1 - export const value = 1;");
    expect(frame).toContain("1 + export const value = 2;");
    expect(frame).toContain("2 + export const added = true;");
  });

  test("renders the lower-level single-file body primitive", async () => {
    const frame = await captureFrame(
      <HunkDiffBody
        file={createExampleDiff()}
        layout="stack"
        theme="github-dark-default"
        width={88}
        highlight={false}
      />,
      92,
      12,
    );

    expect(frame).toContain("@@ -1,1 +1,2 @@");
    expect(frame).toContain("1   -  export const value = 1;");
    expect(frame).toContain("  1 +  export const value = 2;");
  });

  test("accepts a custom tab width through the public body primitive", async () => {
    const metadata = parseDiffFromFile(
      { cacheKey: "tabs-before", contents: "a\tb\n", name: "tabs.txt" },
      { cacheKey: "tabs-after", contents: "a\tc\n", name: "tabs.txt" },
      { context: 3 },
      true,
    );
    const file = createHunkDiffFile({ id: "tabs", metadata, path: "tabs.txt" });
    const frame = await captureFrame(
      <HunkDiffBody file={file} layout="stack" width={88} tabWidth={8} highlight={false} />,
      92,
      8,
    );

    expect(frame).toContain("a       c");
  });

  test("inserts planned hunk-gap rows before later hunk headers", async () => {
    const before =
      Array.from(
        { length: 12 },
        (_, index) => `export const line${index + 1} = ${index + 1};`,
      ).join("\n") + "\n";
    const after = before
      .replace("export const line2 = 2;", "export const line2 = 200;")
      .replace("export const line11 = 11;", "export const line11 = 1100;");
    const metadata = parseDiffFromFile(
      { cacheKey: "gaps-before", contents: before, name: "multi.ts" },
      { cacheKey: "gaps-after", contents: after, name: "multi.ts" },
      { context: 3 },
      true,
    );
    const file = createHunkDiffFile({ id: "multi", metadata, path: "multi.ts" });
    const frame = await captureFrame(
      <HunkDiffBody file={file} layout="stack" width={88} hunkGap={2} highlight={false} />,
      92,
      24,
    );
    const lines = frame.split("\n");
    const headerIndexes = lines.flatMap((line, index) => (line.includes("@@") ? [index] : []));

    expect(headerIndexes.length).toBeGreaterThanOrEqual(2);
    const secondHeader = headerIndexes[1]!;
    expect(lines[secondHeader - 2]?.trim()).toBe("");
    expect(lines[secondHeader - 1]?.trim()).toBe("");
  });

  test("renders reusable file header and multi-file review stream primitives", async () => {
    const diff = createExampleDiff();
    const frame = await captureFrame(
      <box style={{ width: "100%", flexDirection: "column" }}>
        <HunkDiffFileHeader file={diff} width={88} theme="github-light-default" />
        <HunkReviewStream files={[diff]} layout="split" width={88} theme="github-light-default" />
      </box>,
      92,
      14,
    );

    expect(frame).toContain("example.ts");
    expect(frame).toContain("+2 -1");
    expect(frame).toContain("@@ -1,1 +1,2 @@");
  });

  test("renders filename tabs as fixed-width escapes in headers and navigation", async () => {
    const example = createExampleDiff();
    const diff = createHunkDiffFile({
      ...example,
      id: "tabbed-path",
      path: "src/tab\tname.ts",
    });
    const frame = await captureFrame(
      <box style={{ width: "100%", flexDirection: "column" }}>
        <HunkDiffFileHeader file={diff} width={88} theme="github-dark-default" />
        <HunkFileNav
          files={[diff]}
          selectedFileId="tabbed-path"
          width={32}
          theme="github-dark-default"
        />
      </box>,
      92,
      8,
    );

    expect(frame).toContain("src/tab\\tname.ts");
    expect(frame).toContain("tab\\tname.ts");
    expect(frame).not.toContain("\t");
  });

  test("renders the dedicated file navigation primitive", async () => {
    const frame = await captureFrame(
      <HunkFileNav
        files={[createExampleDiff()]}
        selectedFileId="example"
        width={32}
        theme="github-dark-default"
      />,
      36,
      8,
    );

    expect(frame).toContain("example.ts");
    expect(frame).toContain("+2 -1");
  });

  test("uses a single ellipsis when a file navigation name is truncated", async () => {
    const example = createExampleDiff();
    const file = createHunkDiffFile({
      ...example,
      id: "long-name",
      path: "src/extraordinarily-long-component-name",
    });
    const frame = await captureFrame(<HunkFileNav files={[file]} width={18} />, 22, 6);

    expect(frame).toContain("…");
  });

  test("adapts file navigation from grouped paths to an expanded hierarchy", async () => {
    const example = createExampleDiff();
    const files = [
      createHunkDiffFile({ ...example, id: "alpha", path: "src/ui/alpha.ts" }),
      createHunkDiffFile({ ...example, id: "beta", path: "src/ui/beta.ts" }),
    ];
    const narrowFrame = await captureFrame(<HunkFileNav files={files} width={32} />, 36, 8);
    const wideFrame = await captureFrame(<HunkFileNav files={files} width={33} />, 36, 8);

    expect(narrowFrame).toContain("src/ui/");
    expect(wideFrame).not.toContain("src/ui/");
    expect(wideFrame).toContain("src/");
    expect(wideFrame).toContain("ui/");
    const wideLines = wideFrame.split("\n");
    expect(wideLines.find((line) => line.includes("src/"))?.indexOf("src/")).toBe(1);
    expect(wideLines.find((line) => line.includes("ui/"))?.indexOf("ui/")).toBe(3);
    expect(wideFrame).toContain("alpha.ts");
    expect(wideFrame).toContain("beta.ts");
  });

  test("creates public file models from patch text", () => {
    const files = createHunkDiffFilesFromPatch(`diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -1 +1,2 @@
-export const value = 1;
+export const value = 2;
+export const added = true;
`);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("example.ts");
    expect(files[0]?.stats).toEqual({ additions: 2, deletions: 1 });
    expect(files[0]?.patch).toContain("diff --git a/example.ts b/example.ts");
  });

  test("normalizes noprefix patch text for public file models", () => {
    const files = createHunkDiffFilesFromPatch(`diff --git example.ts example.ts
--- example.ts
+++ example.ts
@@ -1 +1 @@
-before
+after
`);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("example.ts");
    expect(files[0]?.patch).toContain("diff --git a/example.ts b/example.ts");
  });

  test("decodes Git-quoted Unicode paths for public file models", () => {
    const escapedPath = String.raw`\345\233\275\351\232\233\345\214\226/\346\227\245\346\234\254\350\252\236-\360\237\247\252.txt`;
    const files = createHunkDiffFilesFromPatch(`diff --git "a/${escapedPath}" "b/${escapedPath}"
--- "a/${escapedPath}"
+++ "b/${escapedPath}"
@@ -1 +1 @@
-before
+after
`);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("国際化/日本語-🧪.txt");
    expect(files[0]?.metadata.name).toBe("国際化/日本語-🧪.txt");
  });

  test("preserves exact trailing controls from Git-quoted public patch paths", () => {
    const escapedPath = String.raw`line\n`;
    const files = createHunkDiffFilesFromPatch(`diff --git "a/${escapedPath}" "b/${escapedPath}"
--- "a/${escapedPath}"
+++ "b/${escapedPath}"
@@ -1 +1 @@
-before
+after
`);

    expect(files[0]?.path).toBe("line\n");
    expect(files[0]?.metadata.name).toBe("line\n");
  });

  test("exports the bundled theme names", () => {
    expect(HUNK_DIFF_THEME_NAMES).toContain("github-dark-default");
    expect(HUNK_DIFF_THEME_NAMES).toContain("github-light-default");
    expect(HUNK_DIFF_THEME_NAMES).toContain("dracula");
    expect(HUNK_DIFF_THEME_NAMES).toContain("catppuccin-mocha");
  });
});
