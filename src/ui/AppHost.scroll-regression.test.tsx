import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { AppBootstrap } from "../core/types";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";

mock.restore();

const { AppHost } = await import("./AppHost");

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

  return createTestVcsAppBootstrap({
    changesetId: "scroll-regression",
    files: [
      createTestDiffFile({
        after,
        before,
        context: 3,
        id: "big",
        path: "big.ts",
      }),
    ],
  });
}

function createCjkUntrackedScrollBootstrap(): AppBootstrap {
  const cjkPhrase = "這是一段很長的中文內容用來驗證分割視圖滑鼠捲動";
  const after = Array.from(
    { length: 40 },
    (_, index) => `第${String(index + 1).padStart(2, "0")}行${cjkPhrase.repeat(5)}\n`,
  ).join("");

  return createTestVcsAppBootstrap({
    changesetId: "scroll-regression-cjk",
    files: [
      createTestDiffFile({
        after,
        before: "",
        context: 3,
        id: "cjk-new",
        path: "notes.md",
      }),
    ],
  });
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

  test("clips CJK split additions after a wheel scroll repaint", async () => {
    const setup = await testRender(<AppHost bootstrap={createCjkUntrackedScrollBootstrap()} />, {
      width: 80,
      height: 14,
    });

    try {
      await act(async () => {
        await setup.renderOnce();
        await Bun.sleep(100);
        await setup.renderOnce();
      });

      await act(async () => {
        await setup.mockMouse.scroll(50, 8, "down");
        await Bun.sleep(0);
        await setup.renderOnce();
      });

      const scrolledFrame = setup.captureCharFrame();
      expect(scrolledFrame).toContain("▌ 4 + 第04行這是一段很長的中文");
      expect(scrolledFrame).not.toMatch(/\n[^\S\r\n]*滑鼠捲動\s*\n/);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
