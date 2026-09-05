import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quote } from "shell-quote";
import { createTestWorkingTreeRepo, runTestGit } from "../helpers/working-tree";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();
const roots: string[] = [];
setDefaultTimeout(30_000);
afterEach(() => {
  harness.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PTY external editor positioning", () => {
  test("e refuses text-converted unstaged coordinates without launching the editor", async () => {
    const root = createTestWorkingTreeRepo();
    roots.push(root);
    const config = harness.createIsolatedConfigHome();
    const converter = join(config, "converter.cjs");
    writeFileSync(
      converter,
      'const fs = require("node:fs"); process.stdout.write("converted header\\n" + fs.readFileSync(process.argv[2], "utf8"));',
    );
    writeFileSync(join(root, ".gitattributes"), "alpha.txt diff=converted\n");
    runTestGit(root, "config", "diff.converted.textconv", quote([process.execPath, converter]));
    writeFileSync(join(root, "alpha.txt"), "one\nchanged source\nthree\n");
    const editor = join(config, "nvim");
    const record = join(config, "editor-launched");
    writeFileSync(
      editor,
      '#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs"; writeFileSync(process.env.HUNK_TEST_EDITOR_LOG, "launched");\n',
    );
    chmodSync(editor, 0o755);
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--no-extensions", "--mode", "stack", "--", "alpha.txt"],
      cols: 150,
      rows: 30,
      env: { EDITOR: editor, HUNK_TEST_EDITOR_LOG: record, XDG_CONFIG_HOME: config },
    });
    try {
      await session.waitForText("changed source", { timeout: 15_000 });
      await session.press("e");
      await session.waitForText("Cannot map text-converted lines", { timeout: 5_000 });
      expect(existsSync(record)).toBe(false);
    } finally {
      session.close();
    }
  });

  test("e maps the selected change or explicit context line through unstaged insertions", async () => {
    const root = createTestWorkingTreeRepo();
    roots.push(root);
    const source = Array.from({ length: 40 }, (_, index) => `line ${index + 1}\n`).join("");
    writeFileSync(join(root, "alpha.txt"), source);
    runTestGit(root, "add", "alpha.txt");
    runTestGit(root, "commit", "-m", "Long source");
    const staged = source.replace("line 20\n", "selected change\n");
    writeFileSync(join(root, "alpha.txt"), staged);
    runTestGit(root, "add", "alpha.txt");
    writeFileSync(join(root, "alpha.txt"), `insert one\ninsert two\ninsert three\n${staged}`);
    writeFileSync(join(root, "beta.txt"), "selected beta\n");
    runTestGit(root, "add", "beta.txt");
    writeFileSync(join(root, "beta.txt"), "beta before\nbeta before two\nselected beta\n");
    const config = harness.createIsolatedConfigHome();
    const editor = join(config, "nvim");
    const record = join(config, "editor.jsonl");
    writeFileSync(
      editor,
      '#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs"; appendFileSync(process.env.HUNK_TEST_EDITOR_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n',
    );
    chmodSync(editor, 0o755);
    const session = await harness.launchHunk({
      cwd: root,
      args: ["diff", "--staged", "--no-extensions", "--mode", "stack"],
      cols: 150,
      rows: 30,
      env: { EDITOR: editor, HUNK_TEST_EDITOR_LOG: record, XDG_CONFIG_HOME: config },
    });
    const calls = () =>
      existsSync(record)
        ? readFileSync(record, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    try {
      await session.waitForText("selected change", { timeout: 15_000 });
      session.writeRaw("ee");
      await harness.waitForSnapshot(session, () => calls().length >= 1, 10_000);
      expect(calls()).toEqual([["+23", join(root, "alpha.txt")]]);
      await session.waitForText("line 17");
      const lines = session
        .getTerminalData()
        .lines.map((line) => line.spans.map((span) => span.text).join(""));
      const row = lines.findIndex((line) => line.includes("line 17"));
      const column = lines[row]!.indexOf("line 17") + 1;
      session.writeRaw(`\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`);
      await session.waitIdle();
      await session.press("e");
      await harness.waitForSnapshot(session, () => calls().length >= 2, 10_000);
      expect(calls()[1]).toEqual(["+20", join(root, "alpha.txt")]);
      const headerLines = session
        .getTerminalData()
        .lines.map((line) => line.spans.map((span) => span.text).join(""));
      const headerRow = headerLines.findIndex((line) => line.includes("alpha.txt"));
      const headerCol = headerLines[headerRow]!.indexOf("alpha.txt") + 1;
      session.writeRaw(
        `\x1b[<0;${headerCol};${headerRow + 1}M\x1b[<0;${headerCol};${headerRow + 1}m`,
      );
      await session.waitIdle();
      await session.press("e");
      await harness.waitForSnapshot(session, () => calls().length >= 3, 10_000);
      expect(calls()[2]).toEqual(["+23", join(root, "alpha.txt")]);
      session.writeRaw(".e");
      await harness.waitForSnapshot(session, () => calls().length >= 4, 10_000);
      expect(calls()[3]).toEqual(["+3", join(root, "beta.txt")]);
    } finally {
      session.close();
    }
  });
});
