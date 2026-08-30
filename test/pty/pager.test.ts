import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Session } from "tuistory";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup, redraws, and wheel retries enough headroom for slower CI machines. */
setDefaultTimeout(45_000);

afterEach(() => {
  harness.cleanup();
});

/** Retry PTY wheel ticks one at a time so slow CI does not drop a whole scroll burst. */
async function scrollWheelUntil(
  session: Session,
  direction: "down" | "up",
  predicate: (text: string) => boolean,
) {
  let lastErrorMessage = `Timed out waiting for pager wheel scroll ${direction}.`;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (direction === "down") {
      await session.scrollDown(1);
    } else {
      await session.scrollUp(1);
    }

    try {
      return await harness.waitForSnapshot(session, predicate, 700);
    } catch (error) {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(lastErrorMessage);
}

describe("PTY pager", () => {
  test("pager mode hides chrome and pages forward on space", async () => {
    const fixture = harness.createPagerPatchFixture();
    const session = await harness.launchHunk({
      args: ["patch", fixture.patchFile, "--pager"],
      cols: 120,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_23");

      // CI can surface the pager header before the first page is fully ready to consume keys.
      await session.waitIdle({ timeout: 200 });
      await session.press("space");
      const paged = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_23") || text.includes("after_06"),
        5_000,
      );

      expect(paged).not.toContain("View  Navigate  Agent  Help");
      expect(paged).toContain("before_23");
    } finally {
      session.close();
    }
  });

  test("pager mode handles half-page, page-up, and content-jump keyboard navigation", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunk({
      args: ["patch", fixture.patchFile, "--pager"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.press(["ctrl", "d"]);
      const halfPaged = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01"),
        5_000,
      );

      expect(halfPaged).not.toContain("before_01");

      await session.press(["ctrl", "u"]);
      const halfPageRestored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01"),
        5_000,
      );

      expect(halfPageRestored).toContain("before_01");

      await session.press("space");
      const paged = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_18"),
        5_000,
      );

      expect(paged).toContain("before_18");

      await session.press("b");
      const pageRestored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("before_18"),
        5_000,
      );

      expect(pageRestored).toContain("before_01");
      expect(pageRestored).not.toContain("before_18");

      await session.press("end");
      const bottom = await harness.waitForSnapshot(
        session,
        (text) => text.includes("after_60"),
        5_000,
      );

      expect(bottom).toContain("after_60");

      await session.press("home");
      const top = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("after_60"),
        5_000,
      );

      expect(top).toContain("before_01");
      expect(top).not.toContain("after_60");
    } finally {
      session.close();
    }
  });

  test("piped stdin still allows concrete-theme app startup to read terminal input", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchShellCommand({
      command: `printf ignored | ${harness.buildHunkCommand(["diff", "--theme", "github-dark-default"])}`,
      cwd: fixture.dir,
      cols: 120,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).toContain("alpha.ts");

      await session.press("q");
      await session.waitIdle({ timeout: 500 });
    } finally {
      session.close();
    }
  });

  test("stdin patch mode enables mouse wheel scrolling in pager UI", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["patch", "-"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      const scrolled = await scrollWheelUntil(
        session,
        "down",
        (text) => !text.includes("before_01") && text.includes("before_12"),
      );

      expect(scrolled).not.toContain("View  Navigate  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      const restored = await scrollWheelUntil(
        session,
        "up",
        (text) => text.includes("before_01") && !text.includes("before_12"),
      );

      expect(restored).toContain("before_01");
      expect(restored).not.toContain("before_12");
    } finally {
      session.close();
    }
  });

  test("stdin patch auto theme still enables mouse wheel scrolling", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["patch", "-", "--theme", "auto"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      const scrolled = await scrollWheelUntil(
        session,
        "down",
        (text) => !text.includes("before_01") && text.includes("before_12"),
      );

      expect(scrolled).toContain("before_12");
    } finally {
      session.close();
    }
  });

  test("general pager mode enables mouse wheel scrolling for diff-like stdin", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["pager"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      const scrolled = await scrollWheelUntil(
        session,
        "down",
        (text) => !text.includes("before_01") && text.includes("before_12"),
      );

      expect(scrolled).not.toContain("View  Navigate  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      const restored = await scrollWheelUntil(
        session,
        "up",
        (text) => text.includes("before_01") && !text.includes("before_12"),
      );

      expect(restored).toContain("before_01");
      expect(restored).not.toContain("before_12");
    } finally {
      session.close();
    }
  });

  test("general pager mode can display the sidebar file tree", async () => {
    const fixture = harness.createPagerPatchFixture();
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["pager"],
      cols: 120,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Agent  Help");
      expect(harness.countMatches(initial, /scroll\.ts/g)).toBe(1);

      // CI can surface the pager content before the file-backed stdin path is ready for keys.
      await session.waitIdle({ timeout: 200 });
      await session.press("s");
      const sidebarRow = /\bM scroll\.ts\s+\+40 -40/;
      const withSidebar = await harness.waitForSnapshot(
        session,
        (text) => sidebarRow.test(text),
        5_000,
      );

      expect(withSidebar).not.toContain("View  Navigate  Agent  Help");
      expect(withSidebar).toMatch(sidebarRow);
    } finally {
      session.close();
    }
  });

  test("general pager mode navigates between files in the review stream", async () => {
    const fixture = harness.createMultiFilePagerPatchFixture();
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["pager"],
      cwd: fixture.dir,
      cols: 120,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/first\.ts/, { timeout: 15_000 });

      expect(initial).toContain("line01 = 1;");
      expect(initial).not.toContain("secondValue = 2;");

      // The keypress handler is bound after the first paint, so proving one key landed keeps a
      // slow start from being misread as broken file navigation.
      await harness.ensureKeyboardIsLive(session);
      await session.press(".");
      // second.ts is the last file and too short to own the viewport top, so the only correct
      // landing spot is the bottom of the stream. Assert that exact position -- reaching it while
      // first.ts's opening line is gone is what separates a real jump from an incidental redraw.
      const nextFile = await harness.waitForSnapshot(
        session,
        (text) => text.includes("secondValue = 2;") && !text.includes("line01 = 1;"),
        5_000,
      );

      expect(nextFile).toContain("secondValue = 2;");
      expect(nextFile).not.toContain("line01 = 1;");

      await session.press(",");
      const previousFile = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line01 = 1;") && !text.includes("secondValue = 2;"),
        5_000,
      );

      expect(previousFile).toContain("line01 = 1;");
      expect(previousFile).not.toContain("secondValue = 2;");
    } finally {
      session.close();
    }
  });

  test("general pager mode switches layout and reveals the menu bar on demand", async () => {
    const fixture = harness.createMultiFilePagerPatchFixture();
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["pager"],
      cwd: fixture.dir,
      cols: 220,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/first\.ts/, { timeout: 15_000 });

      // Pager chrome starts out of the way, but nothing about it is disabled.
      expect(initial).not.toContain("View  Navigate  Agent  Help");
      expect(initial).toMatch(/▌.*▌/);

      await session.waitIdle({ timeout: 200 });
      await session.press("2");
      const stacked = await harness.waitForSnapshot(
        session,
        (text) => !/▌.*▌/.test(text) && text.includes("line01 = 1;"),
        5_000,
      );

      expect(stacked).not.toMatch(/▌.*▌/);

      await session.press("1");
      const split = await harness.waitForSnapshot(session, (text) => /▌.*▌/.test(text), 5_000);

      expect(split).toMatch(/▌.*▌/);

      await session.type("M");
      const withMenuBar = await harness.waitForSnapshot(
        session,
        (text) => text.includes("View  Navigate  Agent  Help"),
        5_000,
      );

      expect(withMenuBar).toContain("View  Navigate  Agent  Help");
      expect(withMenuBar).toContain("first.ts");
    } finally {
      session.close();
    }
  });

  test("pager mode opens with the sidebar closed even when --sidebar asks for one", async () => {
    const fixture = harness.createPagerPatchFixture();
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["pager", "--sidebar"],
      cols: 120,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(harness.countMatches(initial, /scroll\.ts/g)).toBe(1);

      await session.waitIdle({ timeout: 200 });
      await session.press("s");
      const sidebarRow = /\bM scroll\.ts\s+\+40 -40/;
      const withSidebar = await harness.waitForSnapshot(
        session,
        (text) => sidebarRow.test(text),
        5_000,
      );

      expect(withSidebar).toMatch(sidebarRow);
    } finally {
      session.close();
    }
  });

  test("explicit pager mode still supports mouse wheel scrolling on a TTY", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunk({
      args: ["patch", fixture.patchFile, "--pager"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      const scrolled = await scrollWheelUntil(
        session,
        "down",
        (text) => !text.includes("before_01") && text.includes("before_12"),
      );

      expect(scrolled).not.toContain("View  Navigate  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      const restored = await scrollWheelUntil(
        session,
        "up",
        (text) => text.includes("before_01") && !text.includes("before_12"),
      );

      expect(restored).toContain("before_01");
      expect(restored).not.toContain("before_12");
    } finally {
      session.close();
    }
  });
});
