import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness, rightmostColumnOf } from "./harness";

const harness = createPtyHarness();
const tempDirs: string[] = [];
setDefaultTimeout(45_000);

/** Run one Git fixture command with deterministic author identity. */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "History Tester",
      GIT_AUTHOR_EMAIL: "history@example.com",
      GIT_COMMITTER_NAME: "History Tester",
      GIT_COMMITTER_EMAIL: "history@example.com",
      ...env,
    },
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr?.toString() ?? "Git fixture failed.");
}

/** Create two commits whose selected diff is visible in ordinary Hunk review. */
function createHistoryRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-log-pty-"));
  tempDirs.push(cwd);
  git(cwd, ["init", "-q"]);
  writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'first';\n");
  writeFileSync(join(cwd, "root-only.ts"), "export const rootOnly = true;\n");
  git(cwd, ["add", "history.ts", "root-only.ts"]);
  const firstDate = new Date(2026, 8, 5, 12).toISOString();
  git(cwd, ["commit", "-qm", "First history commit"], {
    GIT_AUTHOR_DATE: firstDate,
    GIT_COMMITTER_DATE: firstDate,
  });
  writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'second';\n");
  const secondDate = new Date(2026, 8, 6, 12).toISOString();
  git(cwd, ["commit", "-qam", "Second history commit", "-m", "Responsive description"], {
    GIT_AUTHOR_DATE: secondDate,
    GIT_COMMITTER_DATE: secondDate,
  });
  return cwd;
}

/** Create a merge whose second-parent comparison exposes only the main-side file. */
function createMergeHistoryRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "hunk-log-merge-pty-"));
  tempDirs.push(cwd);
  git(cwd, ["init", "-q"]);
  writeFileSync(join(cwd, "base.ts"), "export const base = true;\n");
  git(cwd, ["add", "base.ts"]);
  git(cwd, ["commit", "-qm", "Root"]);
  const defaultBranch = Bun.spawnSync(["git", "branch", "--show-current"], {
    cwd,
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();
  git(cwd, ["checkout", "-qb", "side"]);
  writeFileSync(join(cwd, "side.ts"), "export const side = true;\n");
  git(cwd, ["add", "side.ts"]);
  git(cwd, ["commit", "-qm", "Side"]);
  git(cwd, ["checkout", "-q", defaultBranch]);
  writeFileSync(join(cwd, "main.ts"), "export const main = true;\n");
  git(cwd, ["add", "main.ts"]);
  git(cwd, ["commit", "-qm", "Main"]);
  git(cwd, ["merge", "--no-ff", "-qm", "Merge side", "side"]);
  return cwd;
}

afterEach(() => {
  harness.cleanup();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("interactive hunk log", () => {
  test("cancels a slow bundled Git review without blocking terminal input", async () => {
    const cwd = createHistoryRepo();
    const binDir = mkdtempSync(join(tmpdir(), "hunk-slow-git-bin-"));
    tempDirs.push(binDir);
    const gitPath = Bun.which("git");
    if (!gitPath) throw new Error("Git is required for the PTY history fixture.");
    const wrapper = join(binDir, "git");
    writeFileSync(
      wrapper,
      `#!/bin/sh\ncase " $* " in *" show "*|*" diff "*) sleep 10 ;; esac\nexec ${JSON.stringify(gitPath)} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });

    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      await session.press("enter");
      await session.waitForText(/Preparing review/, { timeout: 5_000 });
      const cancelledAt = Date.now();
      session.writeRaw("\x03");
      while (
        !session.getRawOutput().slice(-2_000).includes("\x1b[?1049l") &&
        Date.now() - cancelledAt < 3_000
      ) {
        await Bun.sleep(25);
      }
      expect(Date.now() - cancelledAt).toBeLessThan(3_000);
      expect(session.getRawOutput().slice(-2_000)).toContain("\x1b[?1049l");
      expect(session.getRawOutput()).not.toContain("historyValue = 'second'");
    } finally {
      session.writeRaw("\x03");
    }
  });

  test("opens an inclusive root range and retains it when returning", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
    });

    try {
      const history = await session.waitForText(/Second history commit/, { timeout: 15_000 });
      const rootRowIndex = history
        .split("\n")
        .findIndex((line) => line.includes("First history commit"));
      session.writeRaw("J");
      await session.waitForText(/2 commits selected/, { timeout: 5_000 });
      await session.press("enter");
      const review = await session.waitForText(/rootOnly = true/, { timeout: 15_000 });
      expect(review).toContain("historyValue = 'second'");
      await session.press("q");
      await session.waitForText(/2 commits selected/, { timeout: 15_000 });

      // SGR mouse modifier bit 4 forwards Shift+click through capable terminals.
      session.writeRaw("k");
      await harness.waitForSnapshot(session, (text) => !text.includes("2 commits selected"), 5_000);
      session.writeRaw(`\x1b[<4;50;${rootRowIndex + 1}M\x1b[<4;50;${rootRowIndex + 1}m`);
      await session.waitForText(/2 commits selected/, { timeout: 5_000 });
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("opens the selected immutable commit and returns to the retained history", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
    });

    try {
      const history = await session.waitForText(/Second history commit/, {
        timeout: 15_000,
      });
      expect(history).toContain("First history commit");
      expect(history).toContain("File  View  Navigate  Commit  Help");
      expect(history).toContain("Enter open");

      // Mouse and keyboard share the same menu model and actions.
      session.writeRaw("\x1b[<0;2;1M\x1b[<0;2;1m");
      await session.waitForText(/Open selection/, { timeout: 5_000 });
      await session.press("right");
      await session.press("enter");
      await session.waitForText(/Theme selector/, { timeout: 5_000 });
      await session.press("down");
      await session.press("enter");
      await session.waitForText(/Second history commit/, { timeout: 5_000 });

      // The first row's right-aligned commit id opens immediately without a double-click.
      const firstRowIndex = history
        .split("\n")
        .findIndex((line) => line.includes("Second history commit"));
      const firstRow = history.split("\n")[firstRowIndex] ?? "";
      const commitColumn = firstRow.search(/[0-9a-f]{8}\s+⧉\s*$/);
      expect(commitColumn).toBeGreaterThan(0);
      const transitionOutputStart = session.getRawOutput().length;
      session.writeRaw(
        `\x1b[<0;${commitColumn + 1};${firstRowIndex + 1}M\x1b[<0;${commitColumn + 1};${firstRowIndex + 1}m`,
      );
      const review = await session.waitForText(/historyValue = 'second'/, {
        timeout: 15_000,
      });
      expect(review).toContain("history.ts");
      expect(review).toMatch(/Second history commit.*[0-9a-f]{8,}…\s+⧉/);
      expect(review).toMatch(/history · (?:in .*|.* ago)/);
      expect(review).not.toContain("history · Git");
      expect(session.getRawOutput().slice(transitionOutputStart)).not.toContain("\x1b[?1049l");

      const returnOutputStart = session.getRawOutput().length;
      await session.press("q");
      const returned = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Second history commit") && text.includes("Enter open"),
        15_000,
      );
      expect(returned).toContain("Enter open");
      expect(session.getRawOutput().slice(returnOutputStart)).not.toContain("\x1b[?1049l");

      // The adjacent icon copies without opening the review.
      session.writeRaw(
        `\x1b[<0;${commitColumn + 10};${firstRowIndex + 1}M\x1b[<0;${commitColumn + 10};${firstRowIndex + 1}m`,
      );
      await session.waitForText(/Copied [0-9a-f]{8}/, { timeout: 5_000 });

      // Scrolling the history body dismisses an open dropdown before moving selection.
      await session.press("f10");
      await session.waitForText(/Open selection/, { timeout: 5_000 });
      session.writeRaw("\x1b[<65;50;5M");
      await harness.waitForSnapshot(session, (text) => !text.includes("Open selection"), 5_000);

      // Clicking outside the id selects the second row without opening it.
      session.writeRaw("\x1b[<0;50;5M\x1b[<0;50;5m");
      await session.press("enter");
      const rootReview = await session.waitForText(/historyValue = 'first'/, {
        timeout: 15_000,
      });
      expect(rootReview).toContain("history.ts");
      await session.press("q");
      await session.waitForText(/First history commit/, { timeout: 15_000 });

      // A command key closes an open menu and falls through to canonical dispatch.
      await session.press("f10");
      await session.waitForText(/Open selection/, { timeout: 5_000 });
      session.writeRaw("k\r");
      await session.waitForText(/historyValue = 'second'/, { timeout: 15_000 });
      await session.press("q");
      await session.waitForText(/Second history commit/, { timeout: 15_000 });

      // Opening again without moving proves return restored the immutable-id selection. The
      // coalesced trailing q must be consumed by the log transition rather than closing the child.
      session.writeRaw("\rq");
      await session.waitForText(/historyValue = 'second'/, { timeout: 15_000 });
      await session.press("q");
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("prompts to save a changed theme when the history session quits", async () => {
    const cwd = createHistoryRepo();
    const configHome = mkdtempSync(join(tmpdir(), "hunk-log-view-preferences-"));
    tempDirs.push(configHome);
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      await session.press("t");
      await session.waitForText(/Theme selector/, { timeout: 5_000 });
      await session.press("down");
      await session.press("enter");
      await session.press("q");
      const prompt = await session.waitForText(/Save view preferences\?/, { timeout: 5_000 });
      expect(prompt).toContain('- theme = "github-dark-default"');
      expect(prompt).toContain('+ theme = "github-dark-dimmed"');

      await session.press("s");
      const configPath = join(configHome, "hunk", "config.toml");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !existsSync(configPath)) await Bun.sleep(50);
      expect(readFileSync(configPath, "utf8")).toContain('theme = "github-dark-dimmed"');
    } finally {
      session.close();
    }
  });

  test("adapts GitHub-style grouped rows and right-aligned ids on resize", async () => {
    const cwd = createHistoryRepo();
    const displayId = Bun.spawnSync(["git", "rev-parse", "--short=8", "HEAD"], {
      cwd,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 110,
      rows: 20,
    });
    try {
      const wide = await session.waitForText(/Commits on Sep 6, 2026/, { timeout: 15_000 });
      expect(wide).toContain("history ·");
      expect(wide).toContain("○─ Commits on Sep 6, 2026");
      expect(wide).toContain("Commits on Sep 5, 2026");
      expect(wide).toMatch(/Commits on Sep 6, 2026\n\s*│\s*\n\s*│\s+Second history commit/);
      expect(wide).not.toContain("Responsive description");
      expect(rightmostColumnOf(wide, displayId)).toBeGreaterThan(95);

      session.writeRaw("t");
      await session.waitForText(/Theme selector/, { timeout: 5_000 });
      await session.press("escape");
      await session.waitForText(/Commits on Sep 6, 2026/, { timeout: 5_000 });

      session.resize({ cols: 70, rows: 20 });
      await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("Second history commit") &&
          text.includes("history ·") &&
          text.includes(displayId),
        5_000,
      );
      const medium = await session.text({ immediate: true });
      expect(medium).toContain("history ·");
      expect(rightmostColumnOf(medium, displayId)).toBeGreaterThan(55);
      session.resize({ cols: 42, rows: 18 });
      await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("Second history commit") &&
          !text.includes("2026-") &&
          text.includes(displayId),
        5_000,
      );
      const narrow = await session.text({ immediate: true });
      const narrowCommitLine = narrow
        .split("\n")
        .find((line) => line.includes("Second history commit"));
      expect(narrow).toContain("history ·");
      expect(narrowCommitLine).toContain(displayId);
      expect(narrowCommitLine?.trimStart()).toStartWith("│");
      expect(rightmostColumnOf(narrow, displayId)).toBeGreaterThan(27);
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("forces static scrollback output on a terminal", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--static", "--color", "never", "--no-extensions"],
      cwd,
      cols: 80,
      rows: 24,
    });
    try {
      const output = await session.waitForText(/Author: History Tester/, { timeout: 15_000 });
      expect(output).toContain("Second history commit");
      expect(output).not.toContain("File  View  Navigate");
    } finally {
      session.close();
    }
  });

  test("uses an ASCII timeline by default and preserves the optional graph view", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--ascii", "--no-extensions"],
      cwd,
      cols: 80,
      rows: 16,
      env: { TERM: "dumb", NO_COLOR: "" },
    });
    try {
      const history = await session.waitForText(/Second history commit/, { timeout: 15_000 });
      expect(history).toContain("o- Commits on Sep 6, 2026");
      expect(history).toContain("|");

      await session.press("f10");
      await session.press("right");
      await session.press("down");
      await session.press("enter");
      const graph = await harness.waitForSnapshot(
        session,
        (text) => text.includes("*") && !text.includes("Commits on Sep 6, 2026"),
        5_000,
      );
      expect(graph).not.toContain("●");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("refreshes from a new provider cursor and reveals a new commit", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 90,
      rows: 18,
    });
    try {
      await session.waitForText(/Second history commit/, { timeout: 15_000 });
      writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'third';\n");
      git(cwd, ["commit", "-qam", "Third history commit"]);
      await session.press("r");
      const refreshed = await session.waitForText(/Third history commit/, { timeout: 15_000 });
      expect(refreshed).toContain("History refreshed");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("opens a merge against the provider-selected parent", async () => {
    const cwd = createMergeHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
    });
    try {
      await session.waitForText(/Merge side/, { timeout: 15_000 });
      await session.press("f10");
      await session.press("right");
      await session.press("down");
      await session.press("enter");
      const graph = await session.waitForText(/╯/, { timeout: 5_000 });
      expect(graph).not.toContain("Commits on");

      await session.press("f10");
      await session.press("right");
      await session.press("right");
      await session.press("right");
      await session.waitForText(/Compare with parent/, { timeout: 5_000 });
      await session.press("down");
      await session.press("down");
      await session.press("down");
      await session.press("enter");
      await session.waitForText(/Compare with parent/, { timeout: 5_000 });
      session.writeRaw("\x1b[<65;50;10M");
      await session.waitIdle();
      await session.press("enter");
      const review = await session.waitForText(/main\.ts/, { timeout: 15_000 });
      expect(review).not.toContain("side.ts");
      await session.press("q");
      await session.waitForText(/Merge side/, { timeout: 15_000 });
      await session.press("q");
    } finally {
      session.close();
    }
  });
});
