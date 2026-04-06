import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { AppBootstrap } from "../core/types";
import { createTestGitAppBootstrap } from "../../test/helpers/app-bootstrap";
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

  return createTestGitAppBootstrap({
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
