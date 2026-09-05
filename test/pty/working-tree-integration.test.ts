import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestWorkingTreeRepo, runTestGit } from "../helpers/working-tree";
import { createPtyHarness } from "./harness";
import type { Session } from "tuistory";

const harness = createPtyHarness();
const roots: string[] = [];
setDefaultTimeout(30_000);
afterEach(() => {
  harness.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Create a mixed-status fixture without touching the checkout under development. */
function createFixture() {
  const root = createTestWorkingTreeRepo();
  roots.push(root);
  writeFileSync(join(root, "alpha.txt"), "one\nchanged alpha\nthree\n");
  writeFileSync(join(root, "beta.txt"), "staged beta\n");
  runTestGit(root, "add", "beta.txt");
  return root;
}

/** Send a double-click as one input burst at an actual sidebar row, without text's leading newline. */
function sidebarFileClick(session: Session, path: string) {
  const lines = session
    .getTerminalData()
    .lines.map((line) => line.spans.map((span) => span.text).join(""));
  const row = lines.findIndex((line, index) => index > 2 && line.slice(0, 35).includes(path));
  expect(row).toBeGreaterThan(2);
  const col = lines[row]!.indexOf(path) + 1;
  const click = `\x1b[<0;${col};${row + 1}M\x1b[<0;${col};${row + 1}m`;
  return click;
}

/** Deliver consecutive clicks without an intervening wait or render. */
function doubleClickSidebarFile(session: Session, path: string) {
  const click = sidebarFileClick(session, path);
  session.writeRaw(click + click);
}

describe("PTY working-tree staging", () => {
  test("rapid clicks on alternating files remain selection-only", async () => {
    const root = createFixture();
    runTestGit(root, "restore", "--staged", "beta.txt");
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack"],
      cols: 220,
      rows: 30,
    });
    try {
      await session.waitForText("Unstaged (2)", { timeout: 15_000 });
      const alpha = sidebarFileClick(session, "alpha.txt");
      const beta = sidebarFileClick(session, "beta.txt");
      session.writeRaw(alpha + beta + alpha);
      await session.waitIdle();
      expect(runTestGit(root, "diff", "--cached")).toBe("");
      // The active tab is a non-file click even when it does not cause a reload.
      const tab = "\x1b[<0;4;2M\x1b[<0;4;2m";
      session.writeRaw(beta + alpha + tab + alpha);
      await session.waitIdle();
      expect(runTestGit(root, "diff", "--cached")).toBe("");
      const diff = "\x1b[<0;60;8M\x1b[<0;60;8m";
      session.writeRaw(beta + alpha + diff + alpha);
      await session.waitIdle();
      expect(runTestGit(root, "diff", "--cached")).toBe("");
    } finally {
      session.close();
    }
  });

  test("double-clicking an inactive-side file finishes staging after its selection switches tabs", async () => {
    const root = createFixture();
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack"],
      cols: 220,
      rows: 30,
    });
    try {
      await session.waitForText("Unstaged (1)", { timeout: 15_000 });
      doubleClickSidebarFile(session, "beta.txt");
      await session.waitForText("Unstaged beta.txt.", { timeout: 10_000 });
      expect(runTestGit(root, "diff", "--cached")).toBe("");
    } finally {
      session.close();
    }
  });
  test("Space and mouse double-click toggle a file and keep both status sides visible", async () => {
    const root = createFixture();
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack"],
      cols: 220,
      rows: 30,
    });
    try {
      await session.waitForText("Unstaged (1)", { timeout: 15_000 });
      expect(await session.text()).toContain("beta.txt");
      await session.press("space");
      await session.waitForText("Staged alpha.txt.", { timeout: 10_000 });
      expect(runTestGit(root, "show", ":alpha.txt")).toContain("changed alpha");
      doubleClickSidebarFile(session, "alpha.txt");
      await session.waitForText("Unstaged alpha.txt.", { timeout: 10_000 });
      expect(runTestGit(root, "diff", "--cached", "--name-only").trim()).toBe("beta.txt");
      await session.click(/Staged \(1\)/);
      await session.waitForText("staged beta", { timeout: 10_000 });
      await session.press("tab");
      await session.waitForText("changed alpha", { timeout: 10_000 });
    } finally {
      session.close();
    }
  });
});
