import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { ReactNode } from "react";
import { HUNK_DIFF_THEME_NAMES, HunkDiffView, parseDiffFromFile } from "./index";

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

describe("HunkDiffView", () => {
  test("renders a diff through the public OpenTUI entrypoint", async () => {
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

    const frame = await captureFrame(
      <HunkDiffView
        diff={{
          id: "example",
          language: "typescript",
          metadata,
          path: "example.ts",
        }}
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

  test("exports the documented built-in theme names", () => {
    expect(HUNK_DIFF_THEME_NAMES).toEqual(["graphite", "midnight", "paper", "ember"]);
  });
});
