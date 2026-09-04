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
      expect(history).toContain("enter open");

      // The first compact row starts with one graph cell plus two spaces, so x=4
      // lands inside its visible commit id. One press opens without a double-click.
      session.writeRaw("\x1b[<0;5;1M");
      const review = await session.waitForText(/historyValue = 'second'/, {
        timeout: 15_000,
      });
      expect(review).toContain("history.ts");

      await session.press("q");
      const returned = await session.waitForText(/Second history commit/, {
        timeout: 15_000,
      });
      expect(returned).toContain("enter open");

      // Terminals may coalesce rapid navigation and activation into one stdin chunk.
      session.writeRaw("\x1b[B\r");
      const rootReview = await session.waitForText(/historyValue = 'first'/, {
        timeout: 15_000,
      });
      expect(rootReview).toContain("history.ts");
      await session.press("q");
      await session.waitForText(/First history commit/, { timeout: 15_000 });

      // Opening again without moving proves return restored the immutable-id selection.
      await session.press("enter");
      await session.waitForText(/historyValue = 'first'/, { timeout: 15_000 });
      await session.press("q");
      await session.waitForText(/First history commit/, { timeout: 15_000 });
      await session.press("q");
    } finally {
      session.close();
    }
  });
});
