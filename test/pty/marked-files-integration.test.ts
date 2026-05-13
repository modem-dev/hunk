import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("marked files", () => {
  test("pressing m hides the focused file and shift+m restores everything", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      // The first file (alpha.ts) is focused at startup, and its diff content is visible.
      expect(initial).toContain("alphaOnly = true");
      expect(initial).toContain("betaValue = 2");
      expect(initial).not.toMatch(/\d+ hidden/);

      await session.press("m");
      const marked = await harness.waitForSnapshot(
        session,
        (text) => text.includes("1 hidden") && !text.includes("alphaOnly = true"),
        5_000,
      );

      // The hidden footer surfaces the count, and the diff stream no longer shows alpha.ts.
      expect(marked).toContain("1 hidden");
      expect(marked).not.toContain("alphaOnly = true");
      // beta.ts is the next visible file and its diff content is still on screen.
      expect(marked).toContain("betaValue = 2");
      // alpha.ts itself stays in the sidebar so the user can unmark it.
      expect(marked).toContain("alpha.ts");

      await session.type("M");
      const restored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("alphaOnly = true") && !text.match(/\d+ hidden/),
        5_000,
      );

      expect(restored).toContain("alphaOnly = true");
      expect(restored).toContain("betaValue = 2");
      expect(restored).not.toMatch(/\d+ hidden/);
    } finally {
      session.close();
    }
  });
});
