import { describe, expect, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

describe("filter escape clearing (PTY)", () => {
  test("a second Escape clears a re-typed no-match filter query", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 12,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, { timeout: 15_000 });

      // Open filter, type a no-match query.
      await session.type("/");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: type to filter files"),
        5_000,
      );
      await session.type("zzz");
      await harness.waitForSnapshot(session, (t) => t.includes("No files match"), 5_000);

      // First Escape clears the text (keeps the input focused / placeholder shown).
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: type to filter files"),
        5_000,
      );

      // Re-type a no-match query.
      await session.type("zzz");
      await harness.waitForSnapshot(session, (t) => t.includes("No files match"), 5_000);

      // Second Escape must clear again, just like the first.
      await session.press("escape");
      const cleared = await harness.waitForSnapshot(
        session,
        (t) => t.includes("filter: type to filter files") && t.includes("alphaOnly = true"),
        5_000,
      );

      expect(cleared).toContain("filter: type to filter files");
      expect(cleared).toContain("alphaOnly = true");
      expect(cleared).not.toContain("No files match");
    } finally {
      session.close();
    }
  });
});
