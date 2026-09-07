import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Give the files pane keyboard ownership so discard and stash are in scope. */
async function focusFilesPane(session: Session) {
  await harness.ensureKeyboardIsLive(session);
  await session.press(",");
}

describe("PTY working-tree staging", () => {
  test("file quick actions yield to built-ins outside the visible file panel's scope", async () => {
    const root = createFixture();
    const before = readFileSync(join(root, "alpha.txt"), "utf8");
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--no-sidebar", "--no-extensions", "--mode", "stack"],
      cols: 150,
      rows: 30,
    });
    try {
      await session.waitForText("changed alpha", { timeout: 15_000 });
      await session.press("d");
      expect(await session.text()).not.toContain("Discard changes");
      await session.press("s");
      await harness.waitForSnapshot(session, (text) => /M\s+alpha\.txt/.test(text), 5_000);
      expect(await session.text()).not.toContain("Stash selected file");

      // Hunk navigation leaves the sidebar visible but gives review shortcuts ownership.
      await session.press("]");
      await session.press("d");
      expect(await session.text()).not.toContain("Discard changes");
      await session.press("s");
      await harness.waitForSnapshot(session, (text) => !/M\s+alpha\.txt/.test(text), 5_000);
      await session.press("s");
      await harness.waitForSnapshot(session, (text) => /M\s+alpha\.txt/.test(text), 5_000);

      session.writeRaw(sidebarFileClick(session, "alpha.txt"));
      await session.waitIdle();
      await session.press("s");
      await session.waitForText("Stash selected file");
      await session.press("escape");
      await session.press("d");
      await session.waitForText("Discard changes");
      await session.press("escape");

      expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe(before);
      expect(runTestGit(root, "stash", "list")).toBe("");
    } finally {
      session.close();
    }
  });

  test("the sidebar changes an untracked marker into a staged addition", async () => {
    const root = createTestWorkingTreeRepo();
    roots.push(root);
    writeFileSync(join(root, "aaa-new.txt"), "new file content\n");
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack"],
      cols: 150,
      rows: 30,
    });
    try {
      await session.waitForText("new file content", { timeout: 15_000 });
      await harness.waitForSnapshot(session, (text) => /\?\?\s+aaa-new\.txt/.test(text), 5_000);
      await session.press("space");
      await harness.waitForSnapshot(
        session,
        (text) => /A\s+aaa-new\.txt/.test(text) && !/\?\?\s+aaa-new\.txt/.test(text),
        10_000,
      );
      expect(runTestGit(root, "show", ":aaa-new.txt")).toBe("new file content\n");
      await session.press("space");
      await harness.waitForSnapshot(session, (text) => /\?\?\s+aaa-new\.txt/.test(text), 10_000);
      expect(readFileSync(join(root, "aaa-new.txt"), "utf8")).toBe("new file content\n");
    } finally {
      session.close();
    }
  });

  test("folder clicks toggle collapse without staging and Space stages and unstages nested files", async () => {
    const root = createTestWorkingTreeRepo();
    roots.push(root);
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(join(root, "src", "one.ts"), "one\n");
    writeFileSync(join(root, "src", "nested", "two.ts"), "two\n");
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack"],
      cols: 220,
      rows: 30,
    });
    try {
      await session.waitForText("one.ts", { timeout: 15_000 });
      const lines = session
        .getTerminalData()
        .lines.map((line) => line.spans.map((span) => span.text).join(""));
      const row = lines.findIndex((line, index) => {
        if (index <= 2) return false;
        const parts = line.split("│");
        const sidebar = parts.length >= 3 ? (parts[1] ?? "") : (parts[0] ?? "");
        return sidebar.includes("src/") && !sidebar.includes("nested") && !sidebar.includes(".ts");
      });
      expect(row).toBeGreaterThan(2);
      const col = Math.max(2, lines[row]!.indexOf("src/") + 1);
      const click = `\x1b[<0;${col};${row + 1}M\x1b[<0;${col};${row + 1}m`;
      session.writeRaw(click);
      await session.waitForText("Stage folder");
      await session.waitForText("2 files");
      expect(runTestGit(root, "diff", "--cached", "--name-only")).toBe("");
      session.writeRaw(click + click);
      await session.waitForText("2 files");
      expect(runTestGit(root, "diff", "--cached", "--name-only")).toBe("");
      await session.press("space");
      await session.waitForText("Unstage folder");
      expect(runTestGit(root, "show", ":src/one.ts")).toBe("one\n");
      expect(runTestGit(root, "show", ":src/nested/two.ts")).toBe("two\n");
      await session.press("space");
      await session.waitForText("Stage folder");
      expect(runTestGit(root, "diff", "--cached", "--name-only")).toBe("");
    } finally {
      session.close();
    }
  });

  test("discard offers exact-file choices, cancels safely, and preserves staged content with u", async () => {
    const root = createFixture();
    runTestGit(root, "add", "alpha.txt");
    writeFileSync(join(root, "alpha.txt"), "later alpha\n");
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack"],
      cols: 150,
      rows: 30,
    });
    try {
      await session.waitForText("later alpha", { timeout: 15_000 });
      await focusFilesPane(session);
      await session.press("d");
      await session.waitForText("Discard changes");
      await session.press("escape");
      expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("later alpha\n");
      await session.press("d");
      await session.waitForText("unstaged only");
      await session.press("u");
      await session.waitForText("Discarded unstaged changes in alpha.txt.");
      expect(readFileSync(join(root, "alpha.txt"), "utf8")).toContain("changed alpha");
      await session.press("d");
      await session.waitForText("Discard changes");
      const lines = session
        .getTerminalData()
        .lines.map((line) => line.spans.map((span) => span.text).join(""));
      const row = lines.findIndex((line) => line.includes("discard all"));
      const col = lines[row]!.indexOf("discard all") + 1;
      for (const button of [1, 2]) {
        session.writeRaw(`\x1b[<${button};${col};${row + 1}M\x1b[<${button};${col};${row + 1}m`);
        await session.waitIdle();
        expect(readFileSync(join(root, "alpha.txt"), "utf8")).toContain("changed alpha");
        expect(await session.text()).toContain("Discard changes");
      }
      await session.click("discard all");
      await session.waitForText("Discarded all changes in alpha.txt.");
      expect(runTestGit(root, "diff", "HEAD", "--", "alpha.txt")).toBe("");
      expect(runTestGit(root, "show", ":beta.txt")).toBe("staged beta\n");
    } finally {
      session.close();
    }
  });

  test("compact discard keeps every available choice and cancellation visible", async () => {
    const root = createFixture();
    runTestGit(root, "add", "alpha.txt");
    writeFileSync(join(root, "alpha.txt"), "later alpha\n");
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack"],
      cols: 150,
      rows: 18,
    });
    try {
      await session.waitForText("later alpha", { timeout: 15_000 });
      await focusFilesPane(session);
      await session.press("d");
      await session.waitForText("Discard changes");
      session.resize({ cols: 40, rows: 18 });
      await session.waitIdle();
      const frame = await session.waitForText("Discard changes");
      expect(frame).toContain("alpha.txt");
      expect(frame).toContain("x all");
      expect(frame).toContain("u unstaged");
      expect(frame).toContain("esc");
      await session.press("escape");
      expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("later alpha\n");
    } finally {
      session.close();
    }
  });

  test("compact confirmation preserves filename spaces and keeps the warning visible", async () => {
    for (const path of ["a  b.txt", `long-${"x".repeat(180)}.txt`]) {
      const root = createFixture();
      writeFileSync(join(root, path), "new spaced file\n");
      const session = await harness.launchHunk({
        cwd: root,
        args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack", "--", path],
        cols: 150,
        rows: 14,
      });
      try {
        await session.waitForText("new spaced file", { timeout: 15_000 });
        await focusFilesPane(session);
        await session.press("d");
        await session.waitForText("Discard changes");
        session.resize({ cols: 40, rows: 14 });
        await session.waitIdle();
        const frame = await session.waitForText("Discard changes");
        if (path === "a  b.txt") expect(frame).toContain('"a  b.txt"');
        else expect(frame).toContain("…");
        expect(frame).toContain("Cannot undo");
        await session.press("escape");
        expect(readFileSync(join(root, path), "utf8")).toBe("new spaced file\n");
      } finally {
        session.close();
      }
    }
  });

  test("stash message input keeps command letters as text and stashes only the selected file", async () => {
    const root = createFixture();
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack"],
      cols: 150,
      rows: 30,
    });
    try {
      await session.waitForText("changed alpha", { timeout: 15_000 });
      await focusFilesPane(session);
      await session.press("s");
      await session.waitForText("Stash selected file");
      await session.press("escape");
      expect(runTestGit(root, "stash", "list")).toBe("");
      await session.press("s");
      await session.waitForText("Stash selected file");
      session.writeRaw("saved draft d s q");
      await session.waitForText("saved draft d s q");
      await session.press("enter");
      await session.waitForText("Stashed alpha.txt.");
      expect(runTestGit(root, "log", "-1", "--format=%s", "stash")).toContain("saved draft d s q");
      expect(runTestGit(root, "diff", "--name-only", "stash^1", "stash").trim()).toBe("alpha.txt");
      expect(runTestGit(root, "show", ":beta.txt")).toBe("staged beta\n");
    } finally {
      session.close();
    }
  });

  test("double-clicking a hunk without a mutation capability still copies a word", async () => {
    const root = createFixture();
    const index = runTestGit(root, "ls-files", "--stage");
    const configHome = harness.createIsolatedConfigHome();
    const extension = join(configHome, "inventory.ts");
    const result = {
      repoRoot: root,
      sourceLabel: root,
      title: "Read-only inventory",
      patchText: runTestGit(root, "diff", "--", "alpha.txt"),
      workingTreeFiles: [
        {
          path: "alpha.txt",
          staged: false,
          unstaged: true,
          untracked: false,
          conflicted: false,
          version: "test-source",
        },
      ],
    };
    writeFileSync(
      extension,
      `export default (hunk) => hunk.registerVcsAdapter({
      id: "inventory", name: "Inventory", detectionPriority: 1000,
      detect: () => ({ id: "inventory", repoRoot: ${JSON.stringify(root)} }),
      operations: { "working-tree-diff": { load: async () => (${JSON.stringify(result)}) } }
    });`,
    );
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--extension", extension, "--mode", "stack"],
      env: { XDG_CONFIG_HOME: configHome },
      cols: 150,
      rows: 30,
    });
    try {
      await session.waitForText("changed alpha", { timeout: 15_000 });
      const lines = session
        .getTerminalData()
        .lines.map((line) => line.spans.map((span) => span.text).join(""));
      const row = lines.findIndex((line) => line.includes("changed alpha"));
      const col = lines[row]!.indexOf("changed alpha") + 10;
      const click = `\x1b[<0;${col};${row + 1}M\x1b[<0;${col};${row + 1}m`;
      session.writeRaw(click + click);
      await session.waitForText("Copied selection to clipboard", { timeout: 5_000 });
      expect(runTestGit(root, "ls-files", "--stage")).toBe(index);
    } finally {
      session.close();
    }
  });

  test("double-clicking a changed line stages only its hunk", async () => {
    const root = createFixture();
    const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}\n`).join("");
    writeFileSync(join(root, "alpha.txt"), original);
    runTestGit(root, "add", "alpha.txt");
    runTestGit(root, "commit", "--only", "-m", "Long alpha", "--", "alpha.txt");
    writeFileSync(
      join(root, "alpha.txt"),
      original.replace("line 2\n", "first change\n").replace("line 35\n", "second change\n"),
    );
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack"],
      cols: 220,
      rows: 35,
    });
    try {
      await session.waitForText("second change", { timeout: 15_000 });
      const lines = session
        .getTerminalData()
        .lines.map((line) => line.spans.map((span) => span.text).join(""));
      const row = lines.findIndex((line) => line.includes("second change"));
      const column = lines[row]!.indexOf("second change") + 1;
      const click = `\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`;
      // A second press must not mutate before release, and dragging must remain copy-only.
      const down = `\x1b[<0;${column};${row + 1}M`;
      session.writeRaw(click + down);
      await session.waitIdle();
      expect(runTestGit(root, "show", ":alpha.txt")).toBe(original);
      session.writeRaw(`\x1b[<32;${column + 5};${row + 1}M\x1b[<0;${column + 5};${row + 1}m`);
      await session.waitIdle();
      expect(runTestGit(root, "show", ":alpha.txt")).toBe(original);
      // Break the prior click sequence before the ordinary double-click.
      session.writeRaw("\x1b[<0;4;2M\x1b[<0;4;2m" + click + click);
      await session.waitForText("Staged hunk 2 in alpha.txt.", { timeout: 10_000 });
      expect(runTestGit(root, "show", ":alpha.txt")).toBe(
        original.replace("line 35\n", "second change\n"),
      );
      expect(runTestGit(root, "show", ":beta.txt")).toBe("staged beta\n");
    } finally {
      session.close();
    }
  });

  test("a hunk-header click leaves file quick actions", async () => {
    const root = createFixture();
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack"],
      cols: 150,
      rows: 30,
    });
    try {
      await session.waitForText("changed alpha", { timeout: 15_000 });
      await focusFilesPane(session);
      await session.press("d");
      await session.waitForText("Discard changes");
      await session.press("escape");
      const lines = session
        .getTerminalData()
        .lines.map((line) => line.spans.map((span) => span.text).join(""));
      const row = lines.findIndex((line) => line.includes("@@"));
      expect(row).toBeGreaterThan(1);
      const column = lines[row]!.indexOf("@@") + 1;
      session.writeRaw(`\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`);
      await session.waitIdle();
      await session.press("d");
      expect(await session.text()).not.toContain("Discard changes");
      await session.press("s");
      await harness.waitForSnapshot(session, (text) => !/M\s+alpha\.txt/.test(text), 5_000);
      expect(await session.text()).not.toContain("Stash selected file");
    } finally {
      session.close();
    }
  });

  test("a file header returns Space from hunk scope to whole-file scope", async () => {
    const root = createFixture();
    const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}\n`).join("");
    writeFileSync(join(root, "alpha.txt"), original);
    runTestGit(root, "add", "alpha.txt");
    runTestGit(root, "commit", "--only", "-m", "Long alpha", "--", "alpha.txt");
    const changed = original
      .replace("line 2\n", "first change\n")
      .replace("line 35\n", "second change\n");
    writeFileSync(join(root, "alpha.txt"), changed);
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--sidebar", "--no-extensions", "--mode", "stack"],
      cols: 220,
      rows: 35,
    });
    try {
      await session.waitForText("second change", { timeout: 15_000 });
      await session.press("]");
      await session.waitForText("Stage hunk");
      const lines = session
        .getTerminalData()
        .lines.map((line) => line.spans.map((span) => span.text).join(""));
      const row = lines.findIndex((line) => line.indexOf("alpha.txt", 35) >= 35);
      expect(row).toBeGreaterThan(1);
      const column = lines[row]!.indexOf("alpha.txt", 35) + 1;
      session.writeRaw(`\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`);
      await session.waitForText("Stage file");
      // A diff header selects whole-file staging, not sidebar quick-action focus.
      await session.press("d");
      expect(await session.text()).not.toContain("Discard changes");
      await session.press("s");
      await harness.waitForSnapshot(session, (text) => !/M\s+alpha\.txt/.test(text), 5_000);
      expect(await session.text()).not.toContain("Stash selected file");
      await session.press("s");
      await harness.waitForSnapshot(session, (text) => /M\s+alpha\.txt/.test(text), 5_000);
      await session.press("space");
      await session.waitForText("Staged alpha.txt.");
      expect(runTestGit(root, "show", ":alpha.txt")).toBe(changed);
    } finally {
      session.close();
    }
  });

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
