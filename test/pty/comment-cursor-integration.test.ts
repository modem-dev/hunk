import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("comment cursor PTY integration", () => {
  test("user can open the cursor, write a comment, and see it as a note", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 140,
      rows: 28,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await session.press("c");
      const withCursor = await harness.waitForSnapshot(
        session,
        (text) => text.includes("▶"),
        5_000,
      );
      expect(withCursor).toContain("▶");

      await session.press("i");
      const composing = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Comment ·"),
        5_000,
      );
      expect(composing).toContain("Comment ·");

      await session.type("PTY review note");
      await session.press("return");

      const saved = await harness.waitForSnapshot(
        session,
        (text) => text.includes("PTY review note"),
        5_000,
      );
      expect(saved).toContain("PTY review note");
    } finally {
      session.close();
    }
  });
});
