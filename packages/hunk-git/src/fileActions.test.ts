import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestWorkingTreeRepo, runTestGit } from "../../../test/helpers/working-tree";
import { createGitVcsAdapter } from "./index";
import { loadGitWorkingTreeFiles } from "./workingTree";
import { discardGitFile, stashGitFile } from "./fileActions";

const roots: string[] = [];
const input = { kind: "vcs" as const, staged: false, options: {} };
/** Build selected partial changes and unrelated staged/unstaged content. */
function fixture() {
  const root = createTestWorkingTreeRepo();
  roots.push(root);
  writeFileSync(join(root, "alpha.txt"), "staged alpha\n");
  writeFileSync(join(root, "beta.txt"), "staged beta\n");
  runTestGit(root, "add", "alpha.txt", "beta.txt");
  writeFileSync(join(root, "alpha.txt"), "unstaged alpha\n");
  writeFileSync(join(root, "beta.txt"), "unstaged beta\n");
  return root;
}
/** Read the provider's current attestation for an exact test path. */
function status(root: string, path = "alpha.txt") {
  return loadGitWorkingTreeFiles(input, { cwd: root })!.find((file) => file.path === path)!;
}
/** Confirm unrelated content survives both on disk and in the index. */
function expectUnrelated(root: string) {
  expect(runTestGit(root, "show", ":beta.txt")).toBe("staged beta\n");
  expect(readFileSync(join(root, "beta.txt"), "utf8")).toBe("unstaged beta\n");
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("selected-file discard and stash", () => {
  test("unstaged discard retains the selected index, all discard restores only the selected file", async () => {
    const root = fixture();
    await discardGitFile(input, status(root), "unstaged", { cwd: root });
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("staged alpha\n");
    expect(runTestGit(root, "show", ":alpha.txt")).toBe("staged alpha\n");
    await discardGitFile(input, status(root), "all", { cwd: root });
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expect(runTestGit(root, "diff", "HEAD", "--", "alpha.txt")).toBe("");
    expectUnrelated(root);
  });

  test("stash captures only selected partial states, cleans that file, and accepts literal message text", async () => {
    const root = fixture();
    await stashGitFile(input, status(root), "-m literal $message", { cwd: root });
    expect(runTestGit(root, "show", "stash:alpha.txt")).toBe("unstaged alpha\n");
    expect(runTestGit(root, "show", "stash^2:alpha.txt")).toBe("staged alpha\n");
    for (const ref of ["stash", "stash^2"]) {
      expect(runTestGit(root, "diff", "--name-only", "stash^1", ref).trim()).toBe("alpha.txt");
    }
    expect(runTestGit(root, "log", "-1", "--format=%s", "stash")).toContain("-m literal $message");
    expect(runTestGit(root, "diff", "HEAD", "--", "alpha.txt")).toBe("");
    expectUnrelated(root);
    // Native stash application expects a clean destination index; creation preserved beta above.
    runTestGit(root, "restore", "--source=HEAD", "--staged", "--worktree", "--", "beta.txt");
    runTestGit(root, "stash", "apply", "--index");
    expect(runTestGit(root, "show", ":alpha.txt")).toBe("staged alpha\n");
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("unstaged alpha\n");
    expect(readFileSync(join(root, "beta.txt"), "utf8")).toBe("other\n");
  });

  test("stashes an exact untracked path without including another untracked file", async () => {
    const root = fixture();
    writeFileSync(join(root, "[new] file.txt"), "selected\n");
    writeFileSync(join(root, "other.txt"), "unrelated\n");
    await stashGitFile(input, status(root, "[new] file.txt"), "new file", { cwd: root });
    expect(runTestGit(root, "ls-tree", "--name-only", "stash^3").trim()).toBe("[new] file.txt");
    expect(existsSync(join(root, "[new] file.txt"))).toBe(false);
    expect(readFileSync(join(root, "other.txt"), "utf8")).toBe("unrelated\n");
    expectUnrelated(root);
  });

  test("discards added and untracked leaves, and restores staged deletions", async () => {
    const root = fixture();
    for (const staged of [false, true]) {
      writeFileSync(join(root, "new.txt"), "new\n");
      if (staged) runTestGit(root, "add", "new.txt");
      await discardGitFile(input, status(root, "new.txt"), "all", { cwd: root });
      expect(existsSync(join(root, "new.txt"))).toBe(false);
    }
    runTestGit(root, "rm", "--force", "alpha.txt");
    await discardGitFile(input, status(root), "all", { cwd: root });
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expectUnrelated(root);
  });

  test("stash preserves a staged deletion and a staged addition", async () => {
    const root = fixture();
    runTestGit(root, "rm", "--force", "alpha.txt");
    await stashGitFile(input, status(root), "deleted", { cwd: root });
    expect(runTestGit(root, "diff", "--name-status", "stash^1", "stash").trim()).toBe(
      "D\talpha.txt",
    );
    expect(existsSync(join(root, "alpha.txt"))).toBe(true);
    writeFileSync(join(root, "new.txt"), "staged new\n");
    runTestGit(root, "add", "new.txt");
    writeFileSync(join(root, "new.txt"), "unstaged new\n");
    await stashGitFile(input, status(root, "new.txt"), "added", { cwd: root });
    expect(runTestGit(root, "show", "stash^2:new.txt")).toBe("staged new\n");
    expect(runTestGit(root, "show", "stash:new.txt")).toBe("unstaged new\n");
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    expectUnrelated(root);
  });

  test("rename actions retain exact identities and refuse recreated source collisions", async () => {
    const root = fixture();
    runTestGit(root, "restore", "--source=HEAD", "--staged", "--worktree", "alpha.txt");
    renameSync(join(root, "alpha.txt"), join(root, "renamed.txt"));
    runTestGit(root, "add", "-A", "--", "alpha.txt", "renamed.txt");
    const renamed = status(root, "renamed.txt");
    expect(renamed.previousPath).toBe("alpha.txt");
    writeFileSync(join(root, "alpha.txt"), "recreated\n");
    for (const action of [
      () => discardGitFile(input, status(root, "renamed.txt"), "all", { cwd: root }),
      () => stashGitFile(input, status(root, "renamed.txt"), "rename", { cwd: root }),
    ]) {
      await expect(action()).rejects.toThrow("recreated");
    }
    rmSync(join(root, "alpha.txt"));
    await stashGitFile(input, status(root, "renamed.txt"), "rename", { cwd: root });
    expect(runTestGit(root, "show", "stash:renamed.txt")).toBe("one\ntwo\nthree\n");
    expect(existsSync(join(root, "renamed.txt"))).toBe(false);
    expect(existsSync(join(root, "alpha.txt"))).toBe(true);
    expectUnrelated(root);
  });

  test("refuses stale targets and locked indexes without creating a stash", async () => {
    const root = fixture();
    const before = status(root);
    writeFileSync(join(root, "alpha.txt"), "changed after prompt\n");
    await expect(discardGitFile(input, before, "all", { cwd: root })).rejects.toThrow(
      "changed since",
    );
    writeFileSync(join(root, ".git", "index.lock"), "test lock");
    await expect(stashGitFile(input, status(root), "locked", { cwd: root })).rejects.toThrow(
      "locked",
    );
    expect(runTestGit(root, "stash", "list")).toBe("");
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("changed after prompt\n");
  });

  // Git hooks require an executable shell script, so this failure-injection case is Unix-only.
  test.skipIf(process.platform === "win32")(
    "retains a published stash when cleanup encounters a new index lock",
    async () => {
      const root = fixture();
      const hook = join(root, ".git", "hooks", "reference-transaction");
      writeFileSync(
        hook,
        '#!/bin/sh\nif [ "$1" = committed ]; then printf "test lock" > .git/index.lock; fi\n',
      );
      chmodSync(hook, 0o755);
      await expect(
        stashGitFile(input, status(root), "safe recovery", { cwd: root }),
      ).rejects.toThrow("stash is retained");
      expect(runTestGit(root, "show", "stash:alpha.txt")).toBe("unstaged alpha\n");
      expect(runTestGit(root, "show", "stash^2:alpha.txt")).toBe("staged alpha\n");
      expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("unstaged alpha\n");
      expectUnrelated(root);
    },
  );

  test("preserves tracked executable and emulated symlink metadata in stash trees", async () => {
    for (const mode of ["100755", "120000"]) {
      const root = createTestWorkingTreeRepo();
      roots.push(root);
      runTestGit(root, "config", "core.filemode", "false");
      runTestGit(root, "config", "core.symlinks", "false");
      writeFileSync(join(root, "mode.txt"), "old target");
      const blob = runTestGit(root, "hash-object", "-w", "mode.txt").trim();
      runTestGit(root, "update-index", "--add", "--cacheinfo", `${mode},${blob},mode.txt`);
      runTestGit(root, "commit", "-m", "Tracked metadata");
      writeFileSync(join(root, "mode.txt"), "new target");
      await stashGitFile(input, status(root, "mode.txt"), "metadata", { cwd: root });
      expect(runTestGit(root, "ls-tree", "stash", "--", "mode.txt")).toStartWith(mode);
      runTestGit(root, "stash", "apply", "--index");
      expect(readFileSync(join(root, "mode.txt"), "utf8")).toBe("new target");
      expect(runTestGit(root, "ls-files", "--stage", "--", "mode.txt")).toStartWith(mode);
    }
  });

  test("stashes a tracked file even when ignore rules match it", async () => {
    const root = fixture();
    writeFileSync(join(root, ".gitignore"), "alpha.txt\n");
    await stashGitFile(input, status(root), "ignored tracked file", { cwd: root });
    expect(runTestGit(root, "show", "stash:alpha.txt")).toBe("unstaged alpha\n");
    expectUnrelated(root);
  });

  test("discard and stash retain the adapter's configured Git executable", async () => {
    const root = fixture();
    const operation = createGitVcsAdapter({ gitExecutable: "hunk-test-missing-custom-git" })
      .operations!["working-tree-diff"]!;
    await expect(operation.discardFile!(input, status(root), "all", { cwd: root })).rejects.toThrow(
      "hunk-test-missing-custom-git",
    );
    await expect(
      operation.stashFile!(input, status(root), "custom", { cwd: root }),
    ).rejects.toThrow("hunk-test-missing-custom-git");
    expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("unstaged alpha\n");
  });

  test("unborn discard removes only its selected leaf and stash refuses without writes", async () => {
    const root = createTestWorkingTreeRepo({ unborn: true });
    roots.push(root);
    writeFileSync(join(root, "new.txt"), "new\n");
    runTestGit(root, "add", "new.txt");
    await expect(
      stashGitFile(input, status(root, "new.txt"), "unborn", { cwd: root }),
    ).rejects.toThrow("first commit");
    await discardGitFile(input, status(root, "new.txt"), "all", { cwd: root });
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    expect(runTestGit(root, "ls-files")).toBe("");
  });
});
