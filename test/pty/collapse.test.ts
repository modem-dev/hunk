import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { clickMouse, createPtyHarness, lineIndexOf } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY generated-file collapse", () => {
  test("collapses a lockfile by default and toggles it with x in a real PTY", async () => {
    const fixture = harness.createNoiseFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 160,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("Maximum update depth exceeded");

      // The lockfile starts collapsed: its placeholder shows, its diff body is hidden,
      // and the ordinary source file still renders in full.
      const collapsed = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Lockfile collapsed"),
        5_000,
      );
      expect(collapsed).toContain("press x to expand");
      expect(collapsed).not.toContain("collapseProbe");
      expect(collapsed).toContain("zeta");

      // The lockfile sorts first and is selected on launch, so x expands it.
      await session.press("x");
      const expanded = await harness.waitForSnapshot(
        session,
        (text) => text.includes("collapseProbe"),
        5_000,
      );
      expect(expanded).toContain("collapseProbe");
      expect(expanded).not.toContain("Lockfile collapsed");
      expect(expanded).not.toContain("Maximum update depth exceeded");

      // x again re-collapses it.
      await session.press("x");
      const recollapsed = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Lockfile collapsed"),
        5_000,
      );
      expect(recollapsed).toContain("Lockfile collapsed");
      expect(recollapsed).not.toContain("collapseProbe");
    } finally {
      session.close();
    }
  });

  test("clicking a collapsed placeholder reveals the file in a real PTY", async () => {
    const fixture = harness.createNoiseFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 160,
      rows: 16,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      const collapsed = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Lockfile collapsed"),
        5_000,
      );
      expect(collapsed).not.toContain("collapseProbe");

      // Click the collapsed placeholder row to reveal the diff (mouse parity with `x`).
      const row = lineIndexOf(collapsed, "Lockfile collapsed");
      expect(row).toBeGreaterThanOrEqual(0);
      await clickMouse(session, 6, row);

      const expanded = await harness.waitForSnapshot(
        session,
        (text) => text.includes("collapseProbe"),
        5_000,
      );
      expect(expanded).toContain("collapseProbe");
      expect(expanded).not.toContain("Maximum update depth exceeded");
    } finally {
      session.close();
    }
  });
});
