import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableThemes } from "../../src/ui/themes";
import { createPtyHarness, lineIndexOf, rowCellBackgrounds, sleep } from "./harness";

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
        "--files",
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
      const themeSelected = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("Adds bonus export.") &&
          text.includes("Theme: github-light-default") &&
          !text.includes("Theme selector"),
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

      // The key column is rendered from the commands' resolved chords.
      expect(helpDialog).toContain("g / Home");
    } finally {
      session.close();
    }
  });

  test("rapid theme preview key repeats keep the selector responsive", async () => {
    const initialThemeId = "github-dark-default";
    const themes = availableThemes();
    const fixture = harness.createRapidThemePreviewTestRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--theme", initialThemeId],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.press("t");
      await session.waitForText(/Theme selector/, { timeout: 5_000 });

      // OS key repeat arrives as a rapid stream while React/OpenTUI drains each preview render.
      for (let index = 0; index < 100; index += 1) {
        session.writeRaw("j");
        await sleep(30);
      }
      await session.waitIdle({ timeout: 800 });
      const selector = await session.text({ immediate: true });

      expect(selector).not.toContain("Maximum update depth exceeded");
      expect(selector).toContain("Theme selector");
      const selectedIndex = themes.findIndex((theme) => selector.includes(`›  ${theme.id}`));
      expect(selectedIndex).toBeGreaterThanOrEqual(0);
      expect(themes[selectedIndex]?.id).not.toBe(initialThemeId);
    } finally {
      session.close();
    }
  });

  test("quit prompt shows the config diff and saves preferences on mouse click", async () => {
    // Own both config scopes so the test can assert what the save action wrote without an
    // ambient repository `.hunk/config.toml` changing the starting preferences.
    const configHome = mkdtempSync(join(tmpdir(), "hunk-tuistory-save-view-"));
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      await session.waitForText(/line60/, { timeout: 15_000 });

      await session.press("t");
      await session.waitForText(/Theme selector/, { timeout: 5_000 });
      await session.press("down");
      await session.waitForText(/›\s+github-dark-dimmed/, { timeout: 5_000 });
      await session.press("enter");
      await harness.waitForSnapshot(session, (text) => !text.includes("Theme selector"), 5_000);

      await session.press("q");
      const prompt = await session.waitForText(/Save view preferences\?/, { timeout: 5_000 });
      expect(prompt).toContain('- theme = "github-dark-default"');
      expect(prompt).toContain('+ theme = "github-dark-dimmed"');
      expect(prompt).toContain("enter/s save");

      await session.click(/enter\/s save/);

      // The save handler writes the config and quits shortly after; poll the
      // file instead of the (soon dead) PTY session.
      const configPath = join(configHome, "hunk", "config.toml");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !existsSync(configPath)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(readFileSync(configPath, "utf8")).toContain('theme = "github-dark-dimmed"');
    } finally {
      session.close();
      rmSync(configHome, { recursive: true, force: true });
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

  test("the menu bar leaves the same one-column gutter the body panes leave", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff"],
      cwd: fixture.dir,
      cols: 100,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      const menuRow = rowCellBackgrounds(session, 0);
      const bodyRow = rowCellBackgrounds(session, lineIndexOf(initial, "export const alpha"));
      const lastColumn = menuRow.length - 1;

      // Outer gutters match the body, so the app keeps one continuous margin.
      expect(menuRow[0]).toBe(bodyRow[0]);
      expect(menuRow[lastColumn]).toBe(bodyRow[bodyRow.length - 1]);

      // The menu bar's own chrome band still fills everything between them.
      expect(menuRow[1]).not.toBe(menuRow[0]);
      expect(menuRow[lastColumn - 1]).not.toBe(menuRow[lastColumn]);
    } finally {
      session.close();
    }
  });
});
