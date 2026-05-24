import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness, dragMouse } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY scrolling", () => {
  test("a short last file does not trap upward scrolling at the bottom edge", async () => {
    const fixture = harness.createBottomClampedRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 10,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await session.press("]");
      const bottomAligned = await harness.waitForSnapshot(
        session,
        (text) => text.includes("shortLine1 = 10;"),
        5_000,
      );

      expect(bottomAligned).not.toContain("line30 = 130");

      for (let iteration = 0; iteration < 4; iteration += 1) {
        await session.press("up");
        await session.waitIdle({ timeout: 200 });
      }

      const movedUp = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line30 = 130"),
        5_000,
      );

      expect(movedUp).toContain("line30 = 130");
    } finally {
      session.close();
    }
  });

  test("clicking and dragging the live scrollbar scrolls the review pane", async () => {
    const fixture = harness.createScrollableFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 10,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line01 = 101");
      expect(initial).not.toContain("line12 = 112");

      await session.scrollDown(5, 60, 6);
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("line08 = 108") || text.includes("line09 = 109"),
        5_000,
      );

      let scrollbarX: number | null = null;
      let trackClicked = "";
      for (const x of [119, 118, 117, 116]) {
        await session.clickAt(x, 8);
        try {
          trackClicked = await harness.waitForSnapshot(
            session,
            (text) => text.includes("line12 = 112") || text.includes("line13 = 113"),
            1_000,
          );
          scrollbarX = x;
          break;
        } catch {
          // Try the next near-edge column; PTY backends differ by one cell at pane edges.
        }
      }

      expect(scrollbarX).not.toBeNull();
      expect(trackClicked).toContain("line1");
      expect(trackClicked).not.toContain("line01 = 101");

      await dragMouse(session, scrollbarX ?? 118, 5, scrollbarX ?? 118, 8);
      const thumbDragged = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line15 = 115") || text.includes("line16 = 116"),
        5_000,
      );

      expect(thumbDragged).toContain("line1");
      expect(thumbDragged).not.toContain("line01 = 101");
    } finally {
      session.close();
    }
  });

  test("mouse wheel scrolling preserves the divider and header handoff in a real PTY", async () => {
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 10,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("first.ts");
      expect(initial).toContain("second.ts");

      await session.scrollDown(17);
      const boundary = await harness.waitForSnapshot(
        session,
        (text) =>
          harness.countMatches(text, /first\.ts/g) === 2 &&
          harness.countMatches(text, /second\.ts/g) === 2 &&
          text.includes("@@ -1,16 +1,16 @@") &&
          text.includes("line17 = 117"),
        5_000,
      );

      expect(boundary).toContain("first.ts");
      expect(boundary).toContain("second.ts");
      expect(boundary).toContain("@@ -1,16 +1,16 @@");
      expect(boundary).toContain("line17 = 117");

      await session.scrollDown(1);
      const nextHeader = await harness.waitForSnapshot(
        session,
        (text) =>
          harness.countMatches(text, /first\.ts/g) === 2 &&
          harness.countMatches(text, /second\.ts/g) === 2 &&
          text.includes("line18 = 118"),
        5_000,
      );

      expect(nextHeader).toContain("first.ts");
      expect(nextHeader).toContain("second.ts");
      expect(nextHeader).toContain("line18 = 118");

      let handedOff: string | null = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await session.scrollDown(1);

        try {
          handedOff = await harness.waitForSnapshot(
            session,
            (text) =>
              harness.countMatches(text, /first\.ts/g) === 1 &&
              harness.countMatches(text, /second\.ts/g) === 2 &&
              !text.includes("@@ -1,16 +1,16 @@"),
            700,
          );
          break;
        } catch {
          // Real PTY wheel events can land a few rows differently across environments.
          // Keep scrolling a little farther before declaring the handoff broken.
        }
      }

      expect(handedOff).not.toBeNull();
      expect(harness.countMatches(handedOff!, /first\.ts/g)).toBe(1);
      expect(harness.countMatches(handedOff!, /second\.ts/g)).toBe(2);
      expect(handedOff!).not.toContain("@@ -1,16 +1,16 @@");
    } finally {
      session.close();
    }
  });

  test("mouse wheel scrolling moves the review pane", async () => {
    const fixture = harness.createScrollableFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 220,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line01 = 101");
      expect(initial).not.toContain("line08 = 108");

      // Give slower CI PTYs one extra settle point so the first wheel event is not dropped.
      await session.waitIdle({ timeout: 200 });
      await session.scrollDown(12);
      const scrolled = await harness.waitForSnapshot(
        session,
        (text) =>
          !text.includes("line01 = 101") &&
          (text.includes("line11 = 111") || text.includes("line12 = 112")),
        5_000,
      );

      expect(scrolled).not.toContain("line01 = 101");
      expect(scrolled.includes("line11 = 111") || scrolled.includes("line12 = 112")).toBe(true);

      await session.scrollUp(12);
      const restored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line01 = 101"),
        5_000,
      );

      expect(restored).toContain("line01 = 101");
    } finally {
      session.close();
    }
  });

  test("the first mouse-wheel step still advances content under the always-pinned file header above a collapsed gap", async () => {
    const fixture = harness.createCollapsedTopRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 10,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("aaa-collapsed.ts");
      expect(initial).toContain("▾ 362 unchanged lines");
      expect(initial).not.toContain("366 - export const line366 = 366;");

      await session.scrollDown(1);
      const advanced = await harness.waitForSnapshot(
        session,
        (text) => text.includes("366 - export const line366 = 366;"),
        5_000,
      );

      expect(advanced).toContain("366 - export const line366 = 366;");
    } finally {
      session.close();
    }
  });

  test("one mouse-wheel step down then up restores the collapsed-gap view beneath the pinned file header", async () => {
    const fixture = harness.createCollapsedTopRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 10,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      const initialHeaderCount = harness.countMatches(initial, /aaa-collapsed\.ts/g);

      await session.scrollDown(1);
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("366 - export const line366 = 366;"),
        5_000,
      );

      await session.scrollUp(1);
      const restored = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("▾ 362 unchanged lines") &&
          harness.countMatches(text, /aaa-collapsed\.ts/g) === initialHeaderCount,
        5_000,
      );

      expect(restored).toContain("▾ 362 unchanged lines");
      expect(restored).not.toContain("366 - export const line366 = 366;");
      expect(harness.countMatches(restored, /aaa-collapsed\.ts/g)).toBe(initialHeaderCount);
    } finally {
      session.close();
    }
  });
});
