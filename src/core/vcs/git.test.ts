import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitVcsAdapter,
  gitEndpointSourceSpec,
  parseGitNumstat,
  shouldSkipLargeTrackedDiff,
  statSignature,
} from "./git";
import type { VcsShowCommandInput, VcsStashShowCommandInput, VcsDiffCommandInput } from "../types";

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

describe("GitVcsAdapter", () => {
  test("detects Git repositories from nested directories", () => {
    const repo = createTempRepo("hunk-git-adapter-detect-");
    const nested = join(repo, "src", "nested");
    mkdirSync(nested, { recursive: true });

    expect(GitVcsAdapter.detect(nested)).toEqual({ id: "git", repoRoot: repo });
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
    } satisfies VcsDiffCommandInput;
    const result = await GitVcsAdapter.operations["working-tree-diff"]!.load(input, { cwd: repo });

    expect(normalizeComparablePath(result.repoRoot)).toBe(normalizeComparablePath(repo));
    expect(result.title).toContain("working tree");
    expect(result.patchText).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patchText).toContain("+new");
    expect(result.extraFiles?.map((file) => file.path)).toContain("untracked.txt");

    const sourceFetcher = result.sourceFetcherBuilder?.({
      path: "tracked.txt",
      type: "change",
      isUntracked: false,
      isBinary: false,
    });
    expect(await sourceFetcher?.getFullText("old")).toBe("old\n");
    expect(await sourceFetcher?.getFullText("new")).toBe("new\n");
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
    } satisfies VcsShowCommandInput;
    const showResult = await GitVcsAdapter.operations["revision-show"]!.load(showInput, {
      cwd: repo,
    });

    expect(showResult.title).toContain("show HEAD");
    expect(showResult.patchText).toContain("diff --git a/file.txt b/file.txt");
    expect(showResult.patchText).toContain("+two");

    const showSourceFetcher = showResult.sourceFetcherBuilder?.({
      path: "file.txt",
      type: "change",
      isUntracked: false,
      isBinary: false,
    });
    expect(await showSourceFetcher?.getFullText("old")).toBe("one\n");
    expect(await showSourceFetcher?.getFullText("new")).toBe("two\n");

    writeFileSync(join(repo, "file.txt"), "three\n");
    git(repo, "stash", "push", "-m", "adapter stash");

    const stashInput = {
      kind: "stash-show",
      options: { vcs: "git" },
    } satisfies VcsStashShowCommandInput;
    const stashResult = await GitVcsAdapter.operations["stash-show"]!.load(stashInput, {
      cwd: repo,
    });

    expect(stashResult.title).toContain("stash");
    expect(stashResult.patchText).toContain("diff --git a/file.txt b/file.txt");
    expect(stashResult.patchText).toContain("+three");
  });

  test("returns null when no Git marker exists up to the filesystem root", () => {
    // A bare temp dir has no .git in any ancestor, exercising the walk-to-root null return.
    expect(GitVcsAdapter.detect(createTempDir("hunk-git-adapter-none-"))).toBeNull();
  });

  test("computes watch signatures for each review operation", () => {
    const repo = createTempRepo("hunk-git-adapter-watch-");
    writeFileSync(join(repo, "file.txt"), "one\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-m", "initial");
    writeFileSync(join(repo, "file.txt"), "two\n");
    writeFileSync(join(repo, "untracked.txt"), "fresh\n");

    // Measure the working-tree signature while the tree is actually dirty, so the assertion is
    // meaningful: it must carry the tracked diff and an untracked-file stat signature.
    const diffSignature = GitVcsAdapter.operations["working-tree-diff"]!.watchSignature!(
      { kind: "vcs", staged: false, options: { vcs: "git" } },
      { cwd: repo },
    );
    expect(diffSignature).toContain("diff --git a/file.txt b/file.txt");
    expect(diffSignature).toContain("untracked:");

    const showSignature = GitVcsAdapter.operations["revision-show"]!.watchSignature!(
      { kind: "show", ref: "HEAD", options: { vcs: "git" } },
      { cwd: repo },
    );
    expect(showSignature).toContain("diff --git");

    // Stash the dirty state so a stash entry exists for the stash-show signature.
    git(repo, "stash", "push", "--include-untracked", "-m", "watch stash");
    const stashSignature = GitVcsAdapter.operations["stash-show"]!.watchSignature!(
      { kind: "stash-show", options: { vcs: "git" } },
      { cwd: repo },
    );
    expect(stashSignature).toContain("diff --git");
  });
});

describe("git numstat and source-spec helpers", () => {
  test("parseGitNumstat keeps well-formed entries and drops malformed ones", () => {
    const text = ["3\t1\tsrc/a.ts", "bad-entry", "x\ty\tsrc/b.ts", "2\t0\tsrc/c.ts"].join("\0");
    expect(parseGitNumstat(text)).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { path: "src/c.ts", additions: 2, deletions: 0 },
    ]);
  });

  test("parseGitNumstat drops binary-file entries that report '-' counts", () => {
    // Git emits `-\t-\t<path>` for binary files; the non-numeric counts fail the finite guard.
    const text = ["-\t-\tsrc/logo.png", "3\t1\tsrc/a.ts"].join("\0");
    expect(parseGitNumstat(text)).toEqual([{ path: "src/a.ts", additions: 3, deletions: 1 }]);
  });

  test("parseGitNumstat returns nothing for empty output", () => {
    expect(parseGitNumstat("")).toEqual([]);
  });

  test("shouldSkipLargeTrackedDiff flags diffs over the line budget", () => {
    expect(
      shouldSkipLargeTrackedDiff({ path: "x", additions: 19_000, deletions: 2_000 }, "/repo"),
    ).toBe(true);
  });

  test("shouldSkipLargeTrackedDiff flags small diffs of very large files", () => {
    const repo = createTempDir("hunk-git-large-file-");
    writeFileSync(join(repo, "big.bin"), "a".repeat(1_100_000));
    expect(shouldSkipLargeTrackedDiff({ path: "big.bin", additions: 1, deletions: 0 }, repo)).toBe(
      true,
    );
  });

  test("shouldSkipLargeTrackedDiff keeps small diffs and tolerates missing files", () => {
    const repo = createTempDir("hunk-git-small-file-");
    writeFileSync(join(repo, "small.txt"), "hello\n");
    expect(
      shouldSkipLargeTrackedDiff({ path: "small.txt", additions: 1, deletions: 1 }, repo),
    ).toBe(false);
    // A path that does not exist on disk must not throw.
    expect(shouldSkipLargeTrackedDiff({ path: "gone.txt", additions: 1, deletions: 1 }, repo)).toBe(
      false,
    );
  });

  test("gitEndpointSourceSpec maps every endpoint kind to a source spec", () => {
    expect(gitEndpointSourceSpec({ kind: "none" }, "/repo", "a.ts")).toEqual({ kind: "none" });
    expect(gitEndpointSourceSpec({ kind: "git-ref", ref: "HEAD" }, "/repo", "a.ts")).toEqual({
      kind: "git-blob",
      repoRoot: "/repo",
      ref: "HEAD",
      path: "a.ts",
    });
    expect(gitEndpointSourceSpec({ kind: "index" }, "/repo", "a.ts")).toEqual({
      kind: "git-index",
      repoRoot: "/repo",
      path: "a.ts",
    });
    expect(gitEndpointSourceSpec({ kind: "worktree" }, "/repo", "a.ts")).toEqual({
      kind: "fs",
      absolutePath: join("/repo", "a.ts"),
    });
  });

  test("statSignature distinguishes present from missing paths", () => {
    const repo = createTempDir("hunk-git-statsig-");
    const present = join(repo, "present.txt");
    writeFileSync(present, "data\n");
    expect(statSignature(present)).toContain(`${present}:`);
    expect(statSignature(present)).not.toContain(":missing");
    expect(statSignature(join(repo, "absent.txt"))).toBe(`${join(repo, "absent.txt")}:missing`);
  });
});
