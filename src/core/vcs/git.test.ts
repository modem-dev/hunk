import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { gitAdapter } from "./git";
import type { ShowCommandInput, StashShowCommandInput, VcsCommandInput } from "../types";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Normalize Windows short/long temp path spellings before path equality assertions. */
function normalizeComparablePath(path: string) {
  const resolvedPath = platform() === "win32" ? realpathSync.native(path) : path;
  return resolvedPath.replace(/\\/g, "/");
}

function git(cwd: string, ...cmd: string[]) {
  const proc = Bun.spawnSync(["git", ...cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `git ${cmd.join(" ")} failed`);
  }

  return Buffer.from(proc.stdout).toString("utf8");
}

function createTempRepo(prefix: string) {
  const dir = createTempDir(prefix);
  git(dir, "init", "--initial-branch", "master");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("gitAdapter", () => {
  test("detects Git repositories from nested directories", () => {
    const repo = createTempRepo("hunk-git-adapter-detect-");
    const nested = join(repo, "src", "nested");
    mkdirSync(nested, { recursive: true });

    expect(gitAdapter.detect(nested)).toEqual({ id: "git", repoRoot: repo });
  });

  test("loads working-tree diffs with untracked files through the neutral operation", async () => {
    const repo = createTempRepo("hunk-git-adapter-diff-");
    writeFileSync(join(repo, "tracked.txt"), "old\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-m", "initial");
    writeFileSync(join(repo, "tracked.txt"), "new\n");
    writeFileSync(join(repo, "untracked.txt"), "fresh\n");

    const input = {
      kind: "vcs",
      staged: false,
      options: { vcs: "git" },
    } satisfies VcsCommandInput;
    const result = await gitAdapter.loadReview({ kind: "working-tree-diff", input }, { cwd: repo });

    expect(normalizeComparablePath(result.repoRoot)).toBe(normalizeComparablePath(repo));
    expect(result.title).toContain("working tree");
    expect(result.patchText).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patchText).toContain("+new");
    expect(result.untrackedFiles).toEqual(["untracked.txt"]);
  });

  test("loads revision and stash patches through adapter operations", async () => {
    const repo = createTempRepo("hunk-git-adapter-show-");
    writeFileSync(join(repo, "file.txt"), "one\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-m", "initial");
    writeFileSync(join(repo, "file.txt"), "two\n");
    git(repo, "commit", "-am", "change");

    const showInput = {
      kind: "show",
      ref: "HEAD",
      options: { vcs: "git" },
    } satisfies ShowCommandInput;
    const showResult = await gitAdapter.loadReview(
      { kind: "revision-show", input: showInput },
      { cwd: repo },
    );

    expect(showResult.title).toContain("show HEAD");
    expect(showResult.patchText).toContain("diff --git a/file.txt b/file.txt");
    expect(showResult.patchText).toContain("+two");

    writeFileSync(join(repo, "file.txt"), "three\n");
    git(repo, "stash", "push", "-m", "adapter stash");

    const stashInput = {
      kind: "stash-show",
      options: { vcs: "git" },
    } satisfies StashShowCommandInput;
    const stashResult = await gitAdapter.loadReview(
      { kind: "stash-show", input: stashInput },
      { cwd: repo },
    );

    expect(stashResult.title).toContain("stash");
    expect(stashResult.patchText).toContain("diff --git a/file.txt b/file.txt");
    expect(stashResult.patchText).toContain("+three");
  });
});
