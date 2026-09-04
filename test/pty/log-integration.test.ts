import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const tempDirs: string[] = [];
setDefaultTimeout(45_000);

/** Run one Git fixture command with deterministic author identity. */
function git(cwd: string, args: string[]) {
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
  git(cwd, ["add", "history.ts"]);
  git(cwd, ["commit", "-qm", "First history commit"]);
  writeFileSync(join(cwd, "history.ts"), "export const historyValue = 'second';\n");
  git(cwd, ["commit", "-qam", "Second history commit"]);
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
  test("opens the selected immutable commit and returns to the retained history", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--interactive", "--color", "never", "--no-extensions"],
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
      await session.waitForText(/Open selected commit/, { timeout: 5_000 });
      await session.press("right");
      await session.press("enter");
      await session.waitForText(/Theme selector/, { timeout: 5_000 });
      await session.press("down");
      await session.press("enter");
      await session.waitForText(/Second history commit/, { timeout: 5_000 });

      // The menu occupies row one; x=5 on the first history row lands inside
      // its commit id and opens immediately without a double-click.
      session.writeRaw("\x1b[<0;5;2M\x1b[<0;5;2m");
      const review = await session.waitForText(/historyValue = 'second'/, {
        timeout: 15_000,
      });
      expect(review).toContain("history.ts");

      await session.press("q");
      const returned = await session.waitForText(/Second history commit/, {
        timeout: 15_000,
      });
      expect(returned).toContain("Enter open");

      // Scrolling the history body dismisses an open dropdown before moving selection.
      await session.press("f10");
      await session.waitForText(/Open selected commit/, { timeout: 5_000 });
      session.writeRaw("\x1b[<65;50;5M");
      await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Open selected commit"),
        5_000,
      );

      // Clicking outside the id selects the second row without opening it.
      session.writeRaw("\x1b[<0;50;3M\x1b[<0;50;3m");
      await session.press("enter");
      const rootReview = await session.waitForText(/historyValue = 'first'/, {
        timeout: 15_000,
      });
      expect(rootReview).toContain("history.ts");
      await session.press("q");
      await session.waitForText(/First history commit/, { timeout: 15_000 });

      // A command key closes an open menu and falls through to canonical dispatch.
      await session.press("f10");
      await session.waitForText(/Open selected commit/, { timeout: 5_000 });
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

  test("uses an ASCII graph in a dumb terminal", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--interactive", "--ascii", "--no-extensions"],
      cwd,
      cols: 80,
      rows: 16,
      env: { TERM: "dumb", NO_COLOR: "" },
    });
    try {
      const history = await session.waitForText(/Second history commit/, { timeout: 15_000 });
      expect(history).toContain("*");
      expect(history).not.toContain("●");
      await session.press("q");
    } finally {
      session.close();
    }
  });

  test("refreshes from a new provider cursor and reveals a new commit", async () => {
    const cwd = createHistoryRepo();
    const session = await harness.launchHunk({
      args: ["log", "--interactive", "--color", "never", "--no-extensions"],
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
      args: ["log", "--interactive", "--color", "never", "--no-extensions"],
      cwd,
      cols: 100,
      rows: 20,
    });
    try {
      await session.waitForText(/Merge side/, { timeout: 15_000 });
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
