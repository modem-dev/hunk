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
        theme="midnight"
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
        theme="graphite"
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

  test("renders reusable file header and multi-file review stream primitives", async () => {
    const diff = createExampleDiff();
    const frame = await captureFrame(
      <box style={{ width: "100%", flexDirection: "column" }}>
        <HunkDiffFileHeader file={diff} width={88} theme="paper" />
        <HunkReviewStream files={[diff]} layout="split" width={88} theme="paper" />
      </box>,
      92,
      14,
    );

    expect(frame).toContain("example.ts");
    expect(frame).toContain("+2 -1");
    expect(frame).toContain("@@ -1,1 +1,2 @@");
  });

  test("renders the dedicated file navigation primitive", async () => {
    const frame = await captureFrame(
      <HunkFileNav
        files={[createExampleDiff()]}
        selectedFileId="example"
        width={32}
        theme="midnight"
      />,
      36,
      8,
    );

    expect(frame).toContain("example.ts");
    expect(frame).toContain("+2 -1");
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

  test("exports the documented built-in theme names", () => {
    expect(HUNK_DIFF_THEME_NAMES).toEqual(["graphite", "midnight", "paper", "ember"]);
  });
});
