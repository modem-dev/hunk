import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY chrome", () => {
  test("top menu mouse navigation can open themes, toggle agent notes, and open help", async () => {
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
        "--agent-notes",
      ],
      cols: 140,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/Adds bonus export\./, { timeout: 15_000 });
      expect(initial).toContain("Highlights the follow-up addition for review.");

      await session.click(/View/);
      const viewMenu = await session.waitForText(/Themes…/, { timeout: 5_000 });
      expect(viewMenu).toContain("Themes…");

      await session.click(/Themes…/);
      const themeSelector = await session.waitForText(/github-light-default/, { timeout: 5_000 });
      expect(themeSelector).toContain("Theme selector");

      await session.click(/github-light-default/);
      await session.press("enter");
      const themeSelected = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Adds bonus export.") && !text.includes("Theme selector"),
        5_000,
      );
      expect(themeSelected).toContain("Adds bonus export.");

      await session.click(/Agent/, { first: true });
      const agentMenu = await session.waitForText(/Next annotated file/, { timeout: 5_000 });
      expect(agentMenu).toContain("Agent notes");

      await session.click(/Agent notes/);
      await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Adds bonus export.") && !text.includes("Agent notes"),
        5_000,
      );

      await session.click(/Agent/, { first: true });
      await session.waitForText(/Agent notes/, { timeout: 5_000 });
      await session.click(/Agent notes/);
      await session.waitForText(/Adds bonus export\./, { timeout: 5_000 });

      await session.click(/Help/);
      await session.waitForText(/Controls help/, { timeout: 5_000 });
      await session.click(/Controls help/);
      const helpDialog = await session.waitForText(/Navigation/, { timeout: 5_000 });

      // The registry-driven help renders scroll.toTop and scroll.toBottom as
      // separate rows, each surfacing its primary binding plus the fallback
      // arrow/Home/End keys.
      expect(helpDialog).toMatch(/g\s*\/\s*Home/);
      expect(helpDialog).toMatch(/G\s*\/\s*End/);
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
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("add = true");
      expect(initial).toContain("betaValue");

      await session.press("tab");
      await session.type("beta");
      const filtered = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("betaValue") && !text.includes("alpha.ts") && !text.includes("add = true"),
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
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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

  test("keyboard help can open with ? in a real PTY", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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

  test("q quits the app while the help dialog is open", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await session.press("?");
      await session.waitForText(/Controls help|Keyboard help/, { timeout: 5_000 });

      await session.press("q");
      // Pre-keymap, the hook only matched Esc to dismiss help, so q fell
      // through to requestQuit. The keymap rewrite briefly broke that path.
      // Quit should clear the chrome row entirely.
      const after = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("View  Navigate  Agent  Help"),
        5_000,
      );
      expect(after).not.toContain("View  Navigate  Agent  Help");
    } finally {
      session.close();
    }
  });

  test("Esc closes the help dialog without quitting the app", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await session.press("?");
      await session.waitForText(/Controls help|Keyboard help/, { timeout: 5_000 });

      // OpenTUI's input parser can buffer a bare \x1b while it disambiguates
      // it from a multi-byte escape sequence; on slower CI runners that
      // buffer can take several hundred ms to settle, so allow 10s.
      await session.press("escape");
      const after = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Controls help") && !text.includes("Keyboard help"),
        10_000,
      );
      expect(after).toMatch(/View\s+Navigate\s+Agent\s+Help/);
      expect(after).not.toContain("Controls help");
      expect(after).not.toContain("Keyboard help");
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
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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
});
