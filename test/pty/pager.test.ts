import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

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

      expect(initial).not.toContain("View  Navigate  Theme  Agent  Help");
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

      expect(paged).not.toContain("View  Navigate  Theme  Agent  Help");
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

      await session.press("d");
      const halfPaged = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01"),
        5_000,
      );

      expect(halfPaged).not.toContain("before_01");

      await session.press("u");
      const halfPageRestored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01"),
        5_000,
      );

      expect(halfPageRestored).toContain("before_01");

      await session.press("space");
      const paged = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_18") || text.includes("after_02"),
        5_000,
      );

      expect(paged.includes("before_18") || paged.includes("after_02")).toBe(true);

      await session.press("b");
      const pageRestored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("after_02"),
        5_000,
      );

      expect(pageRestored).toContain("before_01");
      expect(pageRestored).not.toContain("after_02");

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
      command: `printf ignored | ${harness.buildHunkCommand(["diff", "--theme", "graphite"])}`,
      cwd: fixture.dir,
      cols: 120,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
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

      expect(initial).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      await session.scrollDown(10);
      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01") && text.includes("before_12"),
        5_000,
      );

      expect(scrolled).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      await session.scrollUp(10);
      const restored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("before_12"),
        5_000,
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
      await session.scrollDown(10);
      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01") && text.includes("before_12"),
        5_000,
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

      expect(initial).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      await session.scrollDown(10);
      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01") && text.includes("before_12"),
        5_000,
      );

      expect(scrolled).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      await session.scrollUp(10);
      const restored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("before_12"),
        5_000,
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

      expect(initial).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(harness.countMatches(initial, /scroll\.ts/g)).toBe(1);

      await session.press("s");
      const sidebarRow = /\bM scroll\.ts\s+\+40 -40/;
      const withSidebar = await harness.waitForSnapshot(
        session,
        (text) => sidebarRow.test(text),
        5_000,
      );

      expect(withSidebar).not.toContain("View  Navigate  Theme  Agent  Help");
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

      expect(initial).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      await session.scrollDown(10);
      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01") && text.includes("before_12"),
        5_000,
      );

      expect(scrolled).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      await session.scrollUp(10);
      const restored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("before_12"),
        5_000,
      );

      expect(restored).toContain("before_01");
      expect(restored).not.toContain("before_12");
    } finally {
      session.close();
    }
  });
});
