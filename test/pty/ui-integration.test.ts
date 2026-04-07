import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("live UI integration", () => {
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

      await session.scrollDown(1);
      const handedOff = await harness.waitForSnapshot(
        session,
        (text) =>
          harness.countMatches(text, /first\.ts/g) === 1 &&
          harness.countMatches(text, /second\.ts/g) === 2 &&
          text.includes("line17 = 117") &&
          !text.includes("@@ -1,16 +1,16 @@"),
        5_000,
      );

      expect(harness.countMatches(handedOff, /first\.ts/g)).toBe(1);
      expect(harness.countMatches(handedOff, /second\.ts/g)).toBe(2);
      expect(handedOff).toContain("line17 = 117");
      expect(handedOff).not.toContain("@@ -1,16 +1,16 @@");
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

  test("slash focuses the filter and narrows the visible review stream", async () => {
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

      await session.type("/");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("filter: type to filter files"),
        5_000,
      );

      await session.type("delta");
      const filtered = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("filter: delta") &&
          text.includes("deltaOnly = true") &&
          !text.includes("alphaOnly = true"),
        5_000,
      );

      expect(filtered.toLowerCase()).toContain("filter");
      expect(filtered).toContain("delta");
      expect(filtered).toContain("deltaOnly = true");
      expect(filtered).not.toContain("alphaOnly = true");
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

  test("keyboard help can open with ? in a real PTY", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await session.press("?");
      const help = await harness.waitForSnapshot(
        session,
        (text) =>
          (text.includes("Keyboard help") || text.includes("Controls help")) &&
          text.includes("move line-by-line"),
        5_000,
      );

      expect(help.includes("Keyboard help") || help.includes("Controls help")).toBe(true);
      expect(help).toContain("move line-by-line");
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

  test("keyboard menu navigation can switch layouts in a real PTY", async () => {
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

      await session.press("f10");
      const fileMenu = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Toggle files/filter focus") && text.includes("Quit"),
        5_000,
      );

      expect(fileMenu).toContain("Reload");

      await session.press("right");
      const viewMenu = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Split view") && text.includes("Stacked view"),
        5_000,
      );

      expect(viewMenu).toContain("Auto layout");

      await session.press("down");
      await session.press("enter");
      const stacked = await harness.waitForSnapshot(
        session,
        (text) => !/▌.*▌/.test(text) && text.includes("1   -  export const alpha = 1;"),
        5_000,
      );

      expect(stacked).not.toMatch(/▌.*▌/);
      expect(stacked).toContain("1   -  export const alpha = 1;");
    } finally {
      session.close();
    }
  });

  test("direct layout hotkeys can switch between split, stack, and auto in a real PTY", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).not.toMatch(/▌.*▌/);
      expect(initial).toContain("1   -  export const alpha = 1;");

      await session.press("1");
      const split = await harness.waitForSnapshot(
        session,
        (text) => /▌.*▌/.test(text) && harness.countMatches(text, /alpha\.ts/g) >= 2,
        5_000,
      );

      expect(split).toMatch(/▌.*▌/);

      await session.press("2");
      const stack = await harness.waitForSnapshot(
        session,
        (text) => !/▌.*▌/.test(text) && text.includes("1   -  export const alpha = 1;"),
        5_000,
      );

      expect(stack).not.toMatch(/▌.*▌/);
      expect(stack).toContain("1   -  export const alpha = 1;");

      await session.press("0");
      const auto = await harness.waitForSnapshot(
        session,
        (text) => /▌.*▌/.test(text) && harness.countMatches(text, /alpha\.ts/g) >= 2,
        5_000,
      );

      expect(auto).toMatch(/▌.*▌/);
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

  test("arrow-key horizontal scrolling reveals hidden code columns in a real PTY", async () => {
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

      expect(initial).toContain("this is a very long");
      expect(initial).not.toContain("ge';");

      let shifted = initial;
      for (let index = 0; index < 96; index += 1) {
        await session.press("right");
        shifted = await session.text();
        if (shifted.includes("ge';")) {
          break;
        }
      }

      expect(shifted).toContain("ge';");
      expect(shifted).not.toContain("this is a very long");

      let restored = shifted;
      for (let index = 0; index < 96; index += 1) {
        await session.press("left");
        restored = await session.text();
        if (restored.includes("this is a very long") && !restored.includes("ge';")) {
          break;
        }
      }

      expect(restored).toContain("this is a very long");
      expect(restored).not.toContain("ge';");
    } finally {
      session.close();
    }
  });

  test("wrap toggles reset horizontal code scrolling in a real PTY", async () => {
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

      expect(initial).toContain("this is a very long");
      expect(initial).not.toContain("ge';");

      let shifted = initial;
      for (let index = 0; index < 96; index += 1) {
        await session.press("right");
        shifted = await session.text();
        if (shifted.includes("ge';")) {
          break;
        }
      }

      expect(shifted).toContain("ge';");
      expect(shifted).not.toContain("this is a very long");

      await session.press("w");
      const wrapped = await harness.waitForSnapshot(
        session,
        (text) => text.includes("ge';"),
        5_000,
      );

      expect(wrapped).toContain("this is a very long");
      expect(wrapped).toContain("ge';");

      await session.press("w");
      const reset = await harness.waitForSnapshot(
        session,
        (text) => text.includes("this is a very long") && !text.includes("ge';"),
        5_000,
      );

      expect(reset).toContain("this is a very long");
      expect(reset).not.toContain("ge';");
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
      expect(initial).toContain("··· 362 unchanged lines ···");
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
          text.includes("··· 362 unchanged lines ···") &&
          harness.countMatches(text, /aaa-collapsed\.ts/g) === initialHeaderCount,
        5_000,
      );

      expect(restored).toContain("··· 362 unchanged lines ···");
      expect(restored).not.toContain("366 - export const line366 = 366;");
      expect(harness.countMatches(restored, /aaa-collapsed\.ts/g)).toBe(initialHeaderCount);
    } finally {
      session.close();
    }
  });
});
