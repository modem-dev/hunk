import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act } from "react";
import type { AppBootstrap } from "../src/core/types";

mock.restore();

const { AppHost } = await import("../src/ui/App");

function createScrollBootstrap(): AppBootstrap {
  const before = Array.from(
    { length: 80 },
    (_, index) => `line ${String(index + 1).padStart(2, "0")} old value\n`,
  ).join("");
  const after = Array.from({ length: 80 }, (_, index) =>
    index === 35
      ? `line ${String(index + 1).padStart(2, "0")} new value with long long text abcdefghijklmnopqrstuvwxyz\n`
      : `line ${String(index + 1).padStart(2, "0")} old value\n`,
  ).join("");

  const metadata = parseDiffFromFile(
    {
      name: "big.ts",
      contents: before,
      cacheKey: "scroll:before",
    },
    {
      name: "big.ts",
      contents: after,
      cacheKey: "scroll:after",
    },
    { context: 3 },
    true,
  );

  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: "split",
      },
    },
    changeset: {
      id: "scroll-regression",
      sourceLabel: "repo",
      title: "repo working tree",
      files: [
        {
          id: "big",
          path: "big.ts",
          patch: "",
          language: "typescript",
          stats: {
            additions: 1,
            deletions: 1,
          },
          metadata,
          agent: null,
        },
      ],
    },
    initialMode: "split",
    initialTheme: "midnight",
  };
}

describe("UI scroll regression", () => {
  test("keeps split diff lines intact after a wheel scroll repaint", async () => {
    const setup = await testRender(<AppHost bootstrap={createScrollBootstrap()} />, {
      width: 160,
      height: 20,
    });

    try {
      await act(async () => {
        await setup.renderOnce();
        await Bun.sleep(100);
        await setup.renderOnce();
      });

      const initialFrame = setup.captureCharFrame();
      expect(initialFrame).toContain("36 - line 36 old value");
      expect(initialFrame).toContain("36 + line 36 new value with long long te");

      await act(async () => {
        await setup.mockMouse.scroll(50, 10, "down");
        await Bun.sleep(0);
        await setup.renderOnce();
      });

      const scrolledFrame = setup.captureCharFrame();
      expect(scrolledFrame).toContain("36 - line 36 old value");
      expect(scrolledFrame).toContain("36 + line 36 new value with long long te");
      expect(scrolledFrame).not.toContain("lold value");
      expect(scrolledFrame).not.toContain("36 +  with long long te");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
