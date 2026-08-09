import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness, lineIndexOf, rowCellBackgrounds } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

/** Reserve one loopback port for a menu-triggered browser review daemon. */
async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

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

      // The key column is rendered from the commands' resolved chords.
      expect(helpDialog).toContain("g / Home");
    } finally {
      session.close();
    }
  });

  test("File menu opens the current review in a browser through the shell-free opener", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const port = await reservePort();
    const openerDir = mkdtempSync(join(tmpdir(), "hunk-browser-opener-"));
    const outputPath = join(openerDir, "opened-url.txt");
    const openerName = process.platform === "darwin" ? "open" : "xdg-open";
    const openerPath = join(openerDir, openerName);
    writeFileSync(openerPath, '#!/bin/sh\nprintf "%s" "$1" > "$HUNK_TEST_BROWSER_OUTPUT"\n');
    chmodSync(openerPath, 0o755);
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after],
      cols: 120,
      rows: 24,
      env: {
        HUNK_MCP_DISABLE: "0",
        HUNK_MCP_PORT: String(port),
        HUNK_TEST_BROWSER_OUTPUT: outputPath,
        PATH: `${openerDir}:${process.env.PATH ?? ""}`,
      },
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.click(/File/, { first: true });
      await session.waitForText(/Open in browser/, { timeout: 5_000 });
      await session.click(/Open in browser/);

      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && !existsSync(outputPath)) {
        await Bun.sleep(50);
      }
      expect(readFileSync(outputPath, "utf8")).toMatch(
        new RegExp(`^http://127\\.0\\.0\\.1:${port}/review/[^/]+/#capability=`),
      );
      await session.waitForText(/Opened review in browser/, { timeout: 5_000 });
    } finally {
      session.close();
      try {
        const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
          pid?: number;
        };
        if (health.pid) process.kill(health.pid);
      } catch {
        // The isolated daemon may already be gone after the terminal closes.
      }
      rmSync(openerDir, { recursive: true, force: true });
    }
  });

  test("quit prompt shows the config diff and saves preferences on mouse click", async () => {
    // Own both config scopes so the test can assert what the save action wrote without an
    // ambient repository `.hunk/config.toml` changing the starting preferences.
    const configHome = mkdtempSync(join(tmpdir(), "hunk-tuistory-save-view-"));
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after],
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
