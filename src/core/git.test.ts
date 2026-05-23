import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGitStashShowArgs, resolveGitDiffEndpoints, runGitText } from "./git";
import type { VcsCommandInput } from "./types";

const tempDirs: string[] = [];

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
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  git(dir, "init");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgSign", "false");
  return dir;
}

function makeGitInput(overrides: Partial<VcsCommandInput> = {}): VcsCommandInput {
  return {
    kind: "vcs",
    staged: false,
    options: { mode: "auto" },
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
describe("git command helpers", () => {
  test("disables external diff tools for stash patches", () => {
    const args = buildGitStashShowArgs({
      kind: "stash-show",
      options: { mode: "auto" },
    });

    expect(args).toContain("--no-ext-diff");
  });

  test("reports a friendly error when git is not installed or not on PATH", () => {
    expect(() =>
      runGitText({
        input: {
          kind: "vcs",
          staged: false,
          options: { mode: "auto" },
        },
        args: ["status"],
        gitExecutable: "definitely-not-a-real-git-binary",
      }),
    ).toThrow(
      "Git is required for `hunk diff`, but `definitely-not-a-real-git-binary` was not found in PATH.",
    );
  });
});

describe("resolveGitDiffEndpoints", () => {
  test("staged diffs compare HEAD against the index", () => {
    const repoRoot = createTempRepo("hunk-endpoints-staged-");
    writeFileSync(join(repoRoot, "x.txt"), "x\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "initial");
    const headSha = git(repoRoot, "rev-parse", "HEAD").trim();

    expect(
      resolveGitDiffEndpoints(makeGitInput({ staged: true }), { cwd: repoRoot, repoRoot }),
    ).toEqual({ old: { kind: "git-ref", ref: headSha }, new: { kind: "index" } });
  });

  test("staged diffs in an unborn repo compare missing old source against the index", () => {
    const repoRoot = createTempRepo("hunk-endpoints-staged-unborn-");
    writeFileSync(join(repoRoot, "x.txt"), "x\n");
    git(repoRoot, "add", "x.txt");

    expect(
      resolveGitDiffEndpoints(makeGitInput({ staged: true }), { cwd: repoRoot, repoRoot }),
    ).toEqual({ old: { kind: "none" }, new: { kind: "index" } });
  });

  test("staged diffs against an explicit ref compare that ref against the index", () => {
    const repoRoot = createTempRepo("hunk-endpoints-staged-ref-");
    writeFileSync(join(repoRoot, "x.txt"), "first\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "first");
    const firstSha = git(repoRoot, "rev-parse", "HEAD").trim();

    writeFileSync(join(repoRoot, "x.txt"), "second\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "second");

    writeFileSync(join(repoRoot, "x.txt"), "staged\n");
    git(repoRoot, "add", "x.txt");

    expect(
      resolveGitDiffEndpoints(makeGitInput({ staged: true, range: firstSha }), {
        cwd: repoRoot,
        repoRoot,
      }),
    ).toEqual({ old: { kind: "git-ref", ref: firstSha }, new: { kind: "index" } });
  });

  test("no range diffs the index against the working tree", () => {
    const repoRoot = createTempRepo("hunk-endpoints-no-range-");
    expect(resolveGitDiffEndpoints(makeGitInput(), { cwd: repoRoot, repoRoot })).toEqual({
      old: { kind: "index" },
      new: { kind: "worktree" },
    });
  });

  test("a single rev compares that rev against the working tree", () => {
    const repoRoot = createTempRepo("hunk-endpoints-single-rev-");
    writeFileSync(join(repoRoot, "x.txt"), "first\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "first");
    const headSha = git(repoRoot, "rev-parse", "HEAD").trim();

    const endpoints = resolveGitDiffEndpoints(makeGitInput({ range: "HEAD" }), {
      cwd: repoRoot,
      repoRoot,
    });

    expect(endpoints).not.toBeNull();
    expect(endpoints!.new).toEqual({ kind: "worktree" });
    expect(endpoints!.old).toEqual({ kind: "git-ref", ref: headSha });
  });

  test("two-dot ranges resolve to oldRef..newRef", () => {
    const repoRoot = createTempRepo("hunk-endpoints-two-dot-");
    writeFileSync(join(repoRoot, "x.txt"), "first\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "first");
    const firstSha = git(repoRoot, "rev-parse", "HEAD").trim();

    writeFileSync(join(repoRoot, "x.txt"), "second\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "second");
    const secondSha = git(repoRoot, "rev-parse", "HEAD").trim();

    const endpoints = resolveGitDiffEndpoints(
      makeGitInput({ range: `${firstSha}..${secondSha}` }),
      { cwd: repoRoot, repoRoot },
    );

    expect(endpoints).toEqual({
      old: { kind: "git-ref", ref: firstSha },
      new: { kind: "git-ref", ref: secondSha },
    });
  });

  test("rev^! resolves to the commit's parent..commit pair", () => {
    const repoRoot = createTempRepo("hunk-endpoints-bang-");
    writeFileSync(join(repoRoot, "x.txt"), "first\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "first");
    const firstSha = git(repoRoot, "rev-parse", "HEAD").trim();

    writeFileSync(join(repoRoot, "x.txt"), "second\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "second");
    const secondSha = git(repoRoot, "rev-parse", "HEAD").trim();

    const endpoints = resolveGitDiffEndpoints(makeGitInput({ range: "HEAD^!" }), {
      cwd: repoRoot,
      repoRoot,
    });

    expect(endpoints).toEqual({
      old: { kind: "git-ref", ref: firstSha },
      new: { kind: "git-ref", ref: secondSha },
    });
  });

  test("symmetric difference (A...B) resolves to merge-base(A, B) on the old side and B on the new side", () => {
    const repoRoot = createTempRepo("hunk-endpoints-three-dot-");
    writeFileSync(join(repoRoot, "x.txt"), "base\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "base");
    const baseBranch = git(repoRoot, "rev-parse", "--abbrev-ref", "HEAD").trim();
    const baseSha = git(repoRoot, "rev-parse", "HEAD").trim();

    git(repoRoot, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repoRoot, "x.txt"), "feature\n");
    git(repoRoot, "commit", "-am", "feature");
    const featureSha = git(repoRoot, "rev-parse", "HEAD").trim();

    git(repoRoot, "checkout", "-q", baseBranch);
    writeFileSync(join(repoRoot, "x.txt"), "main-2\n");
    git(repoRoot, "commit", "-am", "main-2");

    // base and feature have diverged: merge-base remains the original `base` SHA,
    // and `A...B` should compare that merge-base to the right-hand ref.
    const endpoints = resolveGitDiffEndpoints(makeGitInput({ range: `${baseBranch}...feature` }), {
      cwd: repoRoot,
      repoRoot,
    });

    expect(endpoints).toEqual({
      old: { kind: "git-ref", ref: baseSha },
      new: { kind: "git-ref", ref: featureSha },
    });
    // Sanity-check that this matches what `git merge-base` would say.
    expect(baseSha).toBe(git(repoRoot, "merge-base", baseBranch, "feature").trim());
    expect(featureSha).not.toBe(baseSha);
  }, 15_000);

  test("returns null for multi-rev ranges that cannot be mapped to a single old/new pair", () => {
    const repoRoot = createTempRepo("hunk-endpoints-multi-");
    writeFileSync(join(repoRoot, "x.txt"), "first\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "first");
    const firstSha = git(repoRoot, "rev-parse", "HEAD").trim();

    writeFileSync(join(repoRoot, "x.txt"), "second\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "second");

    writeFileSync(join(repoRoot, "x.txt"), "third\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "third");

    // Two positive revs (no negatives) is a shape we cannot represent as one
    // old/new pair. Return null so callers disable source-by-ref expansion
    // instead of silently reading from HEAD/the working tree.
    expect(
      resolveGitDiffEndpoints(makeGitInput({ range: `${firstSha} HEAD` }), {
        cwd: repoRoot,
        repoRoot,
      }),
    ).toBeNull();
  });
});
