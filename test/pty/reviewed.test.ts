import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

const REVIEWED_MARKER_PATTERN = /✓ reviewed \(\d+ lines?\)/;

describe("PTY reviewed hunks", () => {
  test("v collapses the selected hunk to a marker and advances to the next hunk", async () => {
    // File-pair fixtures live in a non-repo temp dir, so reviewed state stays
    // session-only and cannot leak marker files into any checkout.
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cwd: fixture.dir,
      cols: 104,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).toContain("line1 = 100");

      await session.press("v");
      const collapsed = await harness.waitForSnapshot(
        session,
        (text) => REVIEWED_MARKER_PATTERN.test(text),
        5_000,
      );

      // The first hunk's body is hidden behind the marker, and marking
      // advanced the selection so the second hunk is revealed.
      expect(collapsed).not.toContain("line1 = 100");
      expect(collapsed).toContain("line60 = 6000");
      expect(collapsed).not.toContain("Maximum update depth exceeded");
    } finally {
      session.close();
    }
  });

  test("hunk navigation stops on a collapsed marker, Enter expands it, and v un-marks it", async () => {
    const fixture = harness.createAgentNavigationRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 160,
      rows: 14,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, { timeout: 15_000 });

      // Step onto alpha's second hunk and mark it reviewed; the selection
      // advances into beta.
      await session.press("]");
      await harness.waitForSnapshot(session, (text) => text.includes("line60 = 6000"), 5_000);
      await session.press("v");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("line81 = 8100") && !text.includes("line60 = 6000"),
        5_000,
      );

      // Walking backward stops on the collapsed marker itself so the keyboard
      // can act on it.
      await session.press("[");
      const onMarker = await harness.waitForSnapshot(
        session,
        (text) => REVIEWED_MARKER_PATTERN.test(text),
        5_000,
      );
      expect(onMarker).not.toContain("line60 = 6000");

      // Enter expands the reviewed hunk body without un-marking it.
      await session.press("enter");
      await harness.waitForSnapshot(session, (text) => text.includes("line60 = 6000"), 5_000);

      // Enter again re-collapses, and v on the marker un-marks the hunk so
      // its body comes back for good.
      await session.press("enter");
      await harness.waitForSnapshot(
        session,
        (text) => REVIEWED_MARKER_PATTERN.test(text) && !text.includes("line60 = 6000"),
        5_000,
      );
      await session.press("v");
      const unmarked = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line60 = 6000") && !REVIEWED_MARKER_PATTERN.test(text),
        5_000,
      );
      expect(unmarked).not.toContain("Maximum update depth exceeded");
    } finally {
      session.close();
    }
  });

  test("reviewed hunks persist to repo marker files and restore on relaunch", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const launch = () =>
      harness.launchHunk({
        args: ["diff", "--mode", "split"],
        cwd: fixture.dir,
        cols: 160,
        rows: 18,
      });

    const firstSession = await launch();
    try {
      const initial = await firstSession.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).toContain("add = true");

      await firstSession.press("v");
      await harness.waitForSnapshot(
        firstSession,
        (text) => REVIEWED_MARKER_PATTERN.test(text) && !text.includes("add = true"),
        5_000,
      );
    } finally {
      firstSession.close();
    }

    // One marker file exists for the reviewed hunk and the cache self-ignores.
    const markerDir = join(fixture.dir, ".hunk", "cache", "reviewed");
    const markers = readdirSync(markerDir);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(readFileSync(join(fixture.dir, ".hunk", "cache", ".gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(join(markerDir, markers[0]!))).toBe(true);

    // A fresh session over the same diff starts with the hunk collapsed.
    const secondSession = await launch();
    try {
      const restored = await harness.waitForSnapshot(
        secondSession,
        (text) => REVIEWED_MARKER_PATTERN.test(text),
        15_000,
      );
      expect(restored).not.toContain("add = true");
      // The unreviewed beta file still renders normally.
      expect(restored).toContain("betaValue");
    } finally {
      secondSession.close();
    }
  });
});
