import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { quote } from "shell-quote";
import { join } from "node:path";
import { createTestWorkingTreeRepo, runTestGit } from "../../../test/helpers/working-tree";
import { loadAppBootstrap } from "../../hunk/src/core/changeset/loaders";
import { getBundledVcsCatalog } from "../../hunk/src/app/vcsCatalog";
import { summarizeHunk } from "../../hunk/src/core/changeset/hunkSummary";
import { mutateGitHunkStaging } from "./hunkStaging";

const roots: string[] = [];
/** Load precisely the hunk summaries and status attestations exposed by the production loader. */
async function review(root: string, staged = false) {
  const input = { kind: "vcs" as const, staged, options: {} };
  const bootstrap = await loadAppBootstrap(input, {
    cwd: root,
    vcsCatalog: getBundledVcsCatalog(),
  });
  return { input, bootstrap };
}
/** Create separated textual changes whose index outcomes can be checked independently. */
function createRepo() {
  const root = createTestWorkingTreeRepo();
  roots.push(root);
  const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}\n`).join("");
  writeFileSync(join(root, "alpha.txt"), original);
  runTestGit(root, "add", "alpha.txt");
  runTestGit(root, "commit", "-m", "Long file");
  return { root, original };
}
/** Invoke the optional provider method through the same file/hunk boundary as the UI. */
async function toggle(root: string, path: string, hunkIndex: number, staged = false) {
  const { input, bootstrap } = await review(root, staged);
  const file = bootstrap.changeset.files.find((file) => file.path === path)!;
  const status = bootstrap.changeset.workingTreeFiles!.find((file) => file.path === path)!;
  await mutateGitHunkStaging(
    input,
    status,
    summarizeHunk(file.metadata.hunks[hunkIndex]!, hunkIndex),
    { cwd: root },
    !staged,
  );
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Git hunk staging", () => {
  test("stages and unstages only the selected hunk, preserving disk and another staged file", async () => {
    const { root, original } = createRepo();
    const changed = original
      .replace("line 2\n", "first change\n")
      .replace("line 35\n", "second change\n");
    writeFileSync(join(root, "alpha.txt"), changed);
    writeFileSync(join(root, "beta.txt"), "unrelated staged\n");
    runTestGit(root, "add", "beta.txt");
    await toggle(root, "alpha.txt", 1);
    expect(runTestGit(root, "show", ":alpha.txt")).toBe(
      original.replace("line 35\n", "second change\n"),
    );
    await toggle(root, "alpha.txt", 0, true);
    expect(runTestGit(root, "show", ":alpha.txt")).toBe(original);
    expect(runTestGit(root, "show", ":beta.txt")).toBe("unrelated staged\n");
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe(changed);
  });

  test("unstaging a renamed file's hunk preserves its index filename and other hunk", async () => {
    const { root, original } = createRepo();
    renameSync(join(root, "alpha.txt"), join(root, "[renamed] file.txt"));
    writeFileSync(
      join(root, "[renamed] file.txt"),
      original.replace("line 2\n", "first change\n").replace("line 35\n", "second change\n"),
    );
    runTestGit(root, "add", "-A");
    await toggle(root, "[renamed] file.txt", 1, true);
    expect(runTestGit(root, "show", ":[renamed] file.txt")).toBe(
      original.replace("line 2\n", "first change\n"),
    );
    expect(runTestGit(root, "ls-files").split("\n")).not.toContain("alpha.txt");
  });

  test("whole added and deleted hunks preserve worktree bytes across both actions", async () => {
    const { root, original } = createRepo();
    writeFileSync(join(root, "[new] file.txt"), "trailing whitespace  \nno newline  ");
    await toggle(root, "[new] file.txt", 0);
    await toggle(root, "[new] file.txt", 0, true);
    expect(readFileSync(join(root, "[new] file.txt"), "utf8")).toBe(
      "trailing whitespace  \nno newline  ",
    );
    rmSync(join(root, "alpha.txt"));
    await toggle(root, "alpha.txt", 0);
    await toggle(root, "alpha.txt", 0, true);
    expect(runTestGit(root, "show", ":alpha.txt")).toBe(original);
  });

  test("applies zero-context hunks without changing CRLF or trailing spaces", async () => {
    const { root } = createRepo();
    runTestGit(root, "config", "core.autocrlf", "false");
    runTestGit(root, "config", "diff.context", "0");
    const original = "first\r\nkeep\r\nlast  ";
    const changed = "changed\r\nkeep\r\nlast altered  ";
    writeFileSync(join(root, "alpha.txt"), original);
    runTestGit(root, "add", "alpha.txt");
    runTestGit(root, "commit", "-m", "CRLF text");
    writeFileSync(join(root, "alpha.txt"), changed);
    await toggle(root, "alpha.txt", 1);
    expect(runTestGit(root, "show", ":alpha.txt")).toBe("first\r\nkeep\r\nlast altered  ");
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe(changed);
  });

  test("preserves non-UTF-8 source bytes when staging and reversing a hunk", async () => {
    const { root, original } = createRepo();
    const changed = Buffer.from(original.replace("line 35\n", "\xe9\n"), "latin1");
    writeFileSync(join(root, "alpha.txt"), changed);
    await toggle(root, "alpha.txt", 0);
    expect(execFileSync("git", ["show", ":alpha.txt"], { cwd: root })).toEqual(changed);
    await toggle(root, "alpha.txt", 0, true);
    expect(execFileSync("git", ["show", ":alpha.txt"], { cwd: root })).toEqual(
      Buffer.from(original),
    );
    expect(readFileSync(join(root, "alpha.txt"))).toEqual(changed);
  });

  test("refuses converted text instead of staging converter output", async () => {
    const { root, original } = createRepo();
    const converter = join(root, "converter.cjs");
    writeFileSync(
      converter,
      `const fs = require("node:fs"); process.stdout.write(fs.readFileSync(process.argv[2], "utf8").replace("second change", "converted text"));`,
    );
    writeFileSync(join(root, ".gitattributes"), "alpha.txt diff=contract\n");
    runTestGit(root, "config", "diff.contract.textconv", quote([process.execPath, converter]));
    writeFileSync(join(root, "alpha.txt"), original.replace("line 35\n", "second change\n"));
    await expect(toggle(root, "alpha.txt", 0)).rejects.toThrow("Text-converted hunks");
    expect(runTestGit(root, "diff", "--cached")).toBe("");
  });

  test("refuses unstage after HEAD changes with the same status and hunk coordinates", async () => {
    const { root, original } = createRepo();
    for (const replacement of ["SECOND", "THIRD"]) {
      writeFileSync(join(root, "alpha.txt"), original.replace("line 2", replacement));
      runTestGit(root, "add", "alpha.txt");
      runTestGit(root, "commit", "-m", replacement);
    }
    runTestGit(root, "reset", "--soft", "HEAD^");
    const { input, bootstrap } = await review(root, true);
    const file = bootstrap.changeset.files.find((file) => file.path === "alpha.txt")!;
    const status = bootstrap.changeset.workingTreeFiles!.find((file) => file.path === "alpha.txt")!;
    const before = runTestGit(root, "show", ":alpha.txt");
    runTestGit(root, "reset", "--soft", "HEAD^");
    await expect(
      mutateGitHunkStaging(
        input,
        status,
        summarizeHunk(file.metadata.hunks[0]!, 0),
        { cwd: root },
        false,
      ),
    ).rejects.toThrow("changed since");
    expect(runTestGit(root, "show", ":alpha.txt")).toBe(before);
  });

  test("refuses a stale hunk before changing the index", async () => {
    const { root, original } = createRepo();
    writeFileSync(join(root, "alpha.txt"), original.replace("line 2\n", "first change\n"));
    const { input, bootstrap } = await review(root);
    const file = bootstrap.changeset.files[0]!;
    const status = bootstrap.changeset.workingTreeFiles![0]!;
    writeFileSync(join(root, "alpha.txt"), "replaced externally\n");
    await expect(
      mutateGitHunkStaging(
        input,
        status,
        summarizeHunk(file.metadata.hunks[0]!, 0),
        { cwd: root },
        true,
      ),
    ).rejects.toThrow("changed since");
    expect(runTestGit(root, "diff", "--cached")).toBe("");
  });
});
