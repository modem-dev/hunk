import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LARGE_DIFF_FILE_MAX_BYTES } from "@hunk/vcs/large-file";
import { createTestWorkingTreeRepo, runTestGit } from "../../../test/helpers/working-tree";
import { loadGitWorkingTreeFiles, mutateGitFileStaging } from "./workingTree";
import { createGitVcsAdapter } from ".";
import type { ExtensionVcsDiffInput } from "hunkdiff/extension";

setDefaultTimeout(30_000);
const roots: string[] = [];
const input: ExtensionVcsDiffInput = { kind: "vcs", staged: false, options: {} };
/** Register ownership of each test repository for cleanup. */
function createRepo(unborn = false) {
  const root = createTestWorkingTreeRepo({ unborn });
  roots.push(root);
  return root;
}
/** Read one file's actual provider status after each irreversible action. */
function status(root: string, path: string) {
  return loadGitWorkingTreeFiles(input, { cwd: root })!.find((file) => file.path === path)!;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("working-tree file staging", () => {
  test("an index lock reports a user-facing error without changing Git", async () => {
    const root = createRepo();
    writeFileSync(join(root, "alpha.txt"), "changed\n");
    const file = status(root, "alpha.txt");
    writeFileSync(join(root, ".git", "index.lock"), "test lock");
    await expect(mutateGitFileStaging(input, file, { cwd: root }, true)).rejects.toMatchObject({
      name: "HunkExtensionUserError",
    });
    expect(runTestGit(root, "diff", "--cached")).toBe("");
  });
  test("partial file stages remaining changes, then unstages without changing disk or unrelated index entries", async () => {
    const root = createRepo();
    writeFileSync(join(root, "alpha.txt"), "one\nstaged\nthree\n");
    runTestGit(root, "add", "alpha.txt");
    writeFileSync(join(root, "alpha.txt"), "one\nstaged\nremaining\n");
    writeFileSync(join(root, "beta.txt"), "unrelated\n");
    runTestGit(root, "add", "beta.txt");
    expect(status(root, "alpha.txt")).toMatchObject({
      staged: true,
      unstaged: true,
      statusCode: "MM",
    });
    await mutateGitFileStaging(input, status(root, "alpha.txt"), { cwd: root }, true);
    expect(status(root, "alpha.txt")).toMatchObject({ staged: true, unstaged: false });
    await mutateGitFileStaging(input, status(root, "alpha.txt"), { cwd: root }, false);
    expect(status(root, "alpha.txt")).toMatchObject({ staged: false, unstaged: true });
    expect(runTestGit(root, "show", ":beta.txt")).toBe("unrelated\n");
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("one\nstaged\nremaining\n");
  });

  test.each([false, true])(
    "new file stage/unstage preserves contents, unborn=%s",
    async (unborn) => {
      const root = createRepo(unborn);
      writeFileSync(join(root, "new.txt"), "new file\n");
      expect(status(root, "new.txt")).toMatchObject({ untracked: true, statusCode: "??" });
      await mutateGitFileStaging(input, status(root, "new.txt"), { cwd: root }, true);
      expect(status(root, "new.txt")).toMatchObject({ untracked: false, statusCode: "A " });
      await mutateGitFileStaging(input, status(root, "new.txt"), { cwd: root }, false);
      expect(status(root, "new.txt")).toMatchObject({ untracked: true, statusCode: "??" });
      expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("new file\n");
    },
  );

  test("literal pathspec magic cannot stage another file", async () => {
    const root = createRepo();
    const path = "[a] file.txt";
    writeFileSync(join(root, path), "literal\n");
    writeFileSync(join(root, "a file.txt"), "must remain untracked\n");
    await mutateGitFileStaging(input, status(root, path), { cwd: root }, true);
    expect(status(root, "a file.txt").untracked).toBe(true);
    expect(runTestGit(root, "ls-files", "--error-unmatch", "--", `:(literal)${path}`).trim()).toBe(
      path,
    );
  });

  test("deleted and renamed paths unstage both index identities", async () => {
    const root = createRepo();
    renameSync(join(root, "alpha.txt"), join(root, "renamed.txt"));
    runTestGit(root, "add", "-A");
    expect(status(root, "renamed.txt").previousPath).toBe("alpha.txt");
    await mutateGitFileStaging(input, status(root, "renamed.txt"), { cwd: root }, false);
    expect(runTestGit(root, "diff", "--cached")).toBe("");
    await mutateGitFileStaging(input, status(root, "alpha.txt"), { cwd: root }, true);
    expect(runTestGit(root, "diff", "--cached", "--name-status")).toContain("D\talpha.txt");
  });

  test.each([false, true])(
    "staging a renamed file preserves its former path, recreated=%s",
    async (recreated) => {
      const root = createRepo();
      renameSync(join(root, "alpha.txt"), join(root, "renamed.txt"));
      runTestGit(root, "add", "-A");
      writeFileSync(join(root, "renamed.txt"), "one\ntwo\nthree\nremaining\n");
      if (recreated) writeFileSync(join(root, "alpha.txt"), "separate untracked file\n");
      await mutateGitFileStaging(input, status(root, "renamed.txt"), { cwd: root }, true);
      expect(runTestGit(root, "show", ":renamed.txt")).toContain("remaining");
      expect(runTestGit(root, "ls-files").split("\n")).not.toContain("alpha.txt");
      if (recreated) expect(status(root, "alpha.txt").untracked).toBe(true);
    },
  );

  test("stale content and stale index state are refused before writes", async () => {
    const root = createRepo();
    writeFileSync(join(root, "alpha.txt"), "reviewed\n");
    const before = status(root, "alpha.txt");
    writeFileSync(join(root, "alpha.txt"), "not reviewed yet\n");
    await expect(mutateGitFileStaging(input, before, { cwd: root }, true)).rejects.toThrow(
      "changed since",
    );
    expect(runTestGit(root, "diff", "--cached")).toBe("");
    const beforeIndex = status(root, "alpha.txt");
    runTestGit(root, "add", "alpha.txt");
    await expect(mutateGitFileStaging(input, beforeIndex, { cwd: root }, true)).rejects.toThrow(
      "changed since",
    );
  });

  test("revision comparisons cannot expose inventory or accept mutations", async () => {
    const root = createRepo();
    writeFileSync(join(root, "alpha.txt"), "changed\n");
    const range = { ...input, range: "HEAD" } as ExtensionVcsDiffInput;
    expect(loadGitWorkingTreeFiles(range, { cwd: root })).toBeUndefined();
    await expect(
      mutateGitFileStaging(range, status(root, "alpha.txt"), { cwd: root }, true),
    ).rejects.toThrow("revision comparisons");
  });

  test("watch signatures include inactive-side status and content changes", async () => {
    const root = createRepo();
    const operation = createGitVcsAdapter().operations["working-tree-diff"];
    writeFileSync(join(root, "beta.txt"), "staged first\n");
    runTestGit(root, "add", "beta.txt");
    const before = await operation.watchSignature!(input, { cwd: root });
    writeFileSync(join(root, "beta.txt"), "staged second\n");
    runTestGit(root, "add", "beta.txt");
    expect(runTestGit(root, "diff")).toBe("");
    expect(await operation.watchSignature!(input, { cwd: root })).not.toBe(before);
  });

  test("both tabs return the complete status inventory through the public adapter", async () => {
    const root = createRepo();
    writeFileSync(join(root, "alpha.txt"), "staged\n");
    runTestGit(root, "add", "alpha.txt");
    writeFileSync(join(root, "beta.txt"), "unstaged\n");
    const operation = createGitVcsAdapter().operations["working-tree-diff"];
    for (const staged of [false, true]) {
      const result = await operation.load({ ...input, staged }, { cwd: root });
      expect(result.workingTreeFiles?.map((file) => file.path)).toEqual(["alpha.txt", "beta.txt"]);
      expect(result.workingTreeFiles?.find((file) => file.path === "alpha.txt")?.stats).toEqual({
        additions: 1,
        deletions: 3,
      });
      expect(result.workingTreeFiles?.find((file) => file.path === "beta.txt")?.stats).toEqual({
        additions: 1,
        deletions: 1,
      });
      expect(result.patchText).toContain(staged ? "a/alpha.txt" : "a/beta.txt");
      expect(result.patchText).not.toContain(staged ? "a/beta.txt" : "a/alpha.txt");
    }
  });

  test("staged review still reports untracked line counts on the status inventory", async () => {
    const root = createRepo();
    writeFileSync(join(root, "new.txt"), "a\nb\nc\n");
    const result = await createGitVcsAdapter().operations["working-tree-diff"]!.load(
      { ...input, staged: true },
      { cwd: root },
    );
    expect(result.workingTreeFiles?.find((file) => file.path === "new.txt")).toMatchObject({
      untracked: true,
      stats: { additions: 3, deletions: 0 },
    });
  });

  test("unstaged review still reports staged rename line counts on the status inventory", async () => {
    const root = createRepo();
    renameSync(join(root, "alpha.txt"), join(root, "renamed.txt"));
    writeFileSync(join(root, "renamed.txt"), "one\nedited\nthree\n");
    runTestGit(root, "add", "-A");
    const result = await createGitVcsAdapter().operations["working-tree-diff"]!.load(input, {
      cwd: root,
    });
    expect(result.workingTreeFiles?.find((file) => file.path === "renamed.txt")?.stats).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  test("staged review caps untracked inventory stats at the large-file byte budget", async () => {
    const root = createRepo();
    const line = `${"x".repeat(99)}\n`;
    writeFileSync(join(root, "huge.txt"), line.repeat(15_000));
    const result = await createGitVcsAdapter().operations["working-tree-diff"]!.load(
      { ...input, staged: true },
      { cwd: root },
    );
    expect(result.workingTreeFiles?.find((file) => file.path === "huge.txt")).toMatchObject({
      untracked: true,
      stats: { additions: LARGE_DIFF_FILE_MAX_BYTES / line.length, deletions: 0 },
    });
  });

  test("staged review counts an untracked symlink as its target path, not the target file", async () => {
    const root = createRepo();
    writeFileSync(join(root, "target.txt"), "a\nb\nc\nd\ne\n");
    symlinkSync("target.txt", join(root, "link.txt"));
    const result = await createGitVcsAdapter().operations["working-tree-diff"]!.load(
      { ...input, staged: true },
      { cwd: root },
    );
    expect(result.workingTreeFiles?.find((file) => file.path === "link.txt")).toMatchObject({
      untracked: true,
      stats: { additions: 1, deletions: 0 },
    });
  });
});
