import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createTuistoryHarness } from "./tuistoryHarness";

const harness = createTuistoryHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("Hunk integration via tuistory", () => {
  test("real PTY sessions can toggle wrapped lines on and off", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 102,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("before.ts");
      expect(initial).toContain("after.ts");
      expect(initial).toContain("this is a very long");
      expect(initial).not.toContain("ge';");

      await session.press("w");
      const wrapped = await harness.waitForSnapshot(
        session,
        (text) => text.includes("ge';"),
        5_000,
      );

      expect(wrapped).toContain("ge';");

      await session.press("w");
      const unwrapped = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("ge';"),
        5_000,
      );

      expect(unwrapped).not.toContain("ge';");
    } finally {
      session.close();
    }
  });

  test("agent notes can be revealed and hidden in the live diff UI", async () => {
    const fixture = harness.createAgentFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        fixture.before,
        fixture.after,
        "--mode",
        "split",
        "--agent-context",
        fixture.agentContext,
      ],
      cols: 140,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("[AI]");
      expect(initial).not.toContain("Adds bonus export.");

      await session.press("a");
      const withNotes = await session.waitForText(/Adds bonus export\./, { timeout: 5_000 });

      expect(withNotes).toContain("Highlights the follow-up addition for review.");

      await session.press("a");
      const withoutNotes = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Adds bonus export."),
        5_000,
      );

      expect(withoutNotes).not.toContain("Adds bonus export.");
    } finally {
      session.close();
    }
  });

  test("real hunk navigation jumps to later hunks in the review stream", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 104,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line1 = 100");
      expect(initial).not.toContain("line60 = 6000");

      await session.press("]");
      const secondHunk = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line60 = 6000"),
        5_000,
      );

      expect(secondHunk).toContain("line60 = 6000");
      expect(secondHunk).toContain("line61 = 6100");
      expect(secondHunk).not.toContain("line1 = 100");
    } finally {
      session.close();
    }
  });

  test("auto layout responds to live terminal resize in a real PTY", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "auto"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const wide = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(harness.countMatches(wide, /alpha\.ts/g)).toBeGreaterThanOrEqual(2);
      expect(wide).toMatch(/▌.*▌/);

      session.resize({ cols: 150, rows: 24 });
      const tight = await harness.waitForSnapshot(session, (text) => !/▌.*▌/.test(text), 5_000);

      expect(harness.countMatches(tight, /alpha\.ts/g)).toBeLessThan(
        harness.countMatches(wide, /alpha\.ts/g),
      );
      expect(tight).not.toMatch(/▌.*▌/);
    } finally {
      session.close();
    }
  });

  test("sidebar selection jumps the main pane without collapsing the review stream", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("alphaOnly = true");
      expect(initial).toContain("betaValue = 2");
      expect(initial).not.toContain("deltaOnly = true");

      await session.click(/M delta\.ts\s+\+2 -1/);
      const jumped = await harness.waitForSnapshot(
        session,
        (text) => text.includes("deltaOnly = true") && !text.includes("alphaOnly = true"),
        5_000,
      );

      expect(jumped).toContain("deltaValue = 2");
      expect(jumped).toContain("deltaOnly = true");
      expect(jumped).not.toContain("alphaOnly = true");
      expect(harness.countMatches(jumped, /epsilon\.ts/g)).toBeGreaterThanOrEqual(2);
    } finally {
      session.close();
    }
  });

  test("clicking a sidebar file pins that file header to the top in a real PTY", async () => {
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

      for (let index = 0; index < 8; index += 1) {
        await session.press("down");
      }

      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line08 = 108") && text.includes("first.ts"),
        5_000,
      );

      expect(scrolled).toContain("first.ts");

      await session.click(/M second\.ts\s+\+16 -16/);
      const pinned = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("second.ts") &&
          text.includes("line17 = 117") &&
          harness.countMatches(text, /first\.ts/g) === 1,
        5_000,
      );

      expect(pinned).toContain("second.ts");
      expect(pinned).toContain("line17 = 117");
      expect(harness.countMatches(pinned, /first\.ts/g)).toBe(1);
    } finally {
      session.close();
    }
  });

  test("explicit split mode stays split after a live resize", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const wide = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(harness.countMatches(wide, /alpha\.ts/g)).toBeGreaterThanOrEqual(2);
      expect(wide).toMatch(/▌.*▌/);

      session.resize({ cols: 140, rows: 24 });
      const tight = await harness.waitForSnapshot(
        session,
        (text) => /▌.*▌/.test(text) && harness.countMatches(text, /alpha\.ts/g) === 1,
        5_000,
      );

      expect(tight).toContain("betaValue = 1");
    } finally {
      session.close();
    }
  });

  test("explicit stack mode stays stacked after a live resize", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 140,
      rows: 24,
    });

    try {
      const narrow = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(harness.countMatches(narrow, /alpha\.ts/g)).toBe(1);
      expect(narrow).not.toMatch(/▌.*▌/);

      session.resize({ cols: 220, rows: 24 });
      const wide = await harness.waitForSnapshot(
        session,
        (text) => !/▌.*▌/.test(text) && harness.countMatches(text, /alpha\.ts/g) >= 2,
        5_000,
      );

      expect(wide).toContain("1   -  export const alpha = 1;");
    } finally {
      session.close();
    }
  });

  test("filter focus narrows the visible review stream in the live app", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("add = true");
      expect(initial).toContain("betaValue");

      await session.press("tab");
      await session.type("beta");
      const filtered = await harness.waitForSnapshot(
        session,
        (text) => text.includes("betaValue") && !text.includes("add = true"),
        5_000,
      );

      expect(filtered.toLowerCase()).toContain("filter");
      expect(filtered).toContain("beta");
      expect(filtered).toContain("betaValue");
      expect(filtered).not.toContain("add = true");
    } finally {
      session.close();
    }
  });

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

  test("mouse menu navigation can switch the diff layout", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toMatch(/▌.*▌/);

      await session.click(/View/);
      const menu = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Stacked view") && text.includes("Split view"),
        5_000,
      );

      expect(menu).toContain("Stacked view");
      expect(menu).toContain("Split view");

      await session.click(/Stacked view/);
      const stacked = await harness.waitForSnapshot(
        session,
        (text) => !/▌.*▌/.test(text) && text.includes("1   -  export const alpha = 1;"),
        5_000,
      );

      expect(stacked).not.toMatch(/▌.*▌/);
      expect(stacked).toContain("1   -  export const alpha = 1;");
      expect(stacked).toContain("1   -  export const beta = 1;");
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

      await session.scrollDown(12);
      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line11 = 111") && !text.includes("line01 = 101"),
        5_000,
      );

      expect(scrolled).toContain("line11 = 111");
      expect(scrolled).not.toContain("line01 = 101");

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
});
