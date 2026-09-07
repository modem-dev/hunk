import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { quote } from "shell-quote";
import { join } from "node:path";
import { createTestWorkingTreeRepo, runTestGit } from "../../../test/helpers/working-tree";
import { loadGitWorkingTreeFiles } from "./workingTree";
import { resolveGitWorkingTreeLine } from "./editorLine";

const roots: string[] = [];
const input = { kind: "vcs" as const, staged: true, options: {} };
/** Build a staged source with a later independent worktree edit. */
function fixture(worktree: (source: string) => string) {
  const root = createTestWorkingTreeRepo();
  roots.push(root);
  const source = Array.from({ length: 10 }, (_, index) => `line ${index + 1}\n`).join("");
  writeFileSync(join(root, "alpha.txt"), source);
  runTestGit(root, "add", "alpha.txt");
  writeFileSync(join(root, "alpha.txt"), worktree(source));
  const file = loadGitWorkingTreeFiles(input, { cwd: root })!.find(
    (file) => file.path === "alpha.txt",
  )!;
  return { root, file };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("working-tree editor line mapping", () => {
  test("accounts for insertions before, but not after, the selected source line", async () => {
    const { root, file } = fixture(
      (source) => `before\n${source.replace("line 5\n", "line 5\nafter\n")}`,
    );
    expect(await resolveGitWorkingTreeLine(input, file, 5, { cwd: root })).toBe(6);
    expect(await resolveGitWorkingTreeLine(input, file, 6, { cwd: root })).toBe(8);
  });
  test("maps removed and replaced lines to surviving working-tree positions", async () => {
    const { root, file } = fixture((source) =>
      source.replace("line 2\nline 3\n", "").replace("line 7\nline 8\n", "replacement\n"),
    );
    expect(await resolveGitWorkingTreeLine(input, file, 3, { cwd: root })).toBe(2);
    expect(await resolveGitWorkingTreeLine(input, file, 8, { cwd: root })).toBe(5);
    expect(await resolveGitWorkingTreeLine(input, file, 10, { cwd: root })).toBe(7);
  });
  test.each([false, true])("refuses text-converted line numbers with staged=%s", async (staged) => {
    const { root, file } = fixture((source) => source.replace("line 5", "changed line 5"));
    const converter = join(root, "converter.cjs");
    writeFileSync(
      converter,
      'const fs = require("node:fs"); process.stdout.write("converted header\\n" + fs.readFileSync(process.argv[2], "utf8"));',
    );
    writeFileSync(join(root, ".gitattributes"), "alpha.txt diff=converted\n");
    runTestGit(root, "config", "diff.converted.textconv", quote([process.execPath, converter]));
    await expect(
      resolveGitWorkingTreeLine({ ...input, staged }, file, 5, { cwd: root }),
    ).rejects.toThrow("text-converted");
  });
  test("keeps an ordinary unstaged source line unchanged", async () => {
    const { root, file } = fixture((source) => `before\n${source}`);
    expect(
      await resolveGitWorkingTreeLine({ ...input, staged: false }, file, 5, { cwd: root }),
    ).toBe(5);
  });
  test("refuses an external change after the review snapshot", async () => {
    const { root, file } = fixture((source) => source);
    writeFileSync(join(root, "alpha.txt"), "later edit\n");
    await expect(resolveGitWorkingTreeLine(input, file, 5, { cwd: root })).rejects.toThrow(
      "changed since",
    );
  });
});
