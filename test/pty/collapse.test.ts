import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY file collapse", () => {
  test("x collapses the selected file to a header placeholder and expands it again", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 104,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).toContain("line1 = 100");

      await session.press("x");
      const collapsed = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Collapsed") && !text.includes("line1 = 100"),
        5_000,
      );
      expect(collapsed).toContain("Collapsed");
      expect(collapsed).not.toContain("line1 = 100");
      // The header chevron flips to the collapsed glyph.
      expect(collapsed).toContain("▸");

      await session.press("x");
      const expanded = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line1 = 100") && !text.includes("Collapsed"),
        5_000,
      );
      expect(expanded).toContain("line1 = 100");
      expect(expanded).not.toContain("Collapsed");
    } finally {
      session.close();
    }
  });
});
