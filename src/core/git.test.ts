import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  buildGitDiffArgs,
  buildGitIgnoredDirectoryArgs,
  buildGitStashShowArgs,
  buildGitStatusArgs,
  listGitIgnoredDirectoryRoots,
  parseGitIgnoredDirectoryRoots,
  resolveGitDiffEndpoints,
  resolveGitMetadata,
  runGitText,
} from "./git";
import type { VcsDiffCommandInput } from "./types";

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

function makeGitInput(overrides: Partial<VcsDiffCommandInput> = {}): VcsDiffCommandInput {
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
  test("enables deterministic color-moved output for patch parsing", () => {
    const args = buildGitDiffArgs(
      {
        kind: "vcs",
        staged: false,
        options: { mode: "auto" },
      },
      [],
      { mode: "zebra", whitespaceMode: "allow-indentation-change" },
    );

    expect(args).toContain("--color=always");
    expect(args).toContain("--color-moved=zebra");
    expect(args).toContain("--color-moved-ws=allow-indentation-change");
    expect(args).not.toContain("--no-color");
    expect(args).toContain("color.diff.oldMoved=magenta bold");
    expect(args).toContain("color.diff.newMoved=cyan bold");
  });

  test("disables external diff tools for stash patches", () => {
    const args = buildGitStashShowArgs({
      kind: "stash-show",
      options: { mode: "auto" },
    });

    expect(args).toContain("--no-ext-diff");
  });

  test("prevents optional index locks while discovering untracked files", () => {
    expect(buildGitStatusArgs(makeGitInput())).toEqual([
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
  });

  test("builds the collapsed ignored-directory query", () => {
    expect(buildGitIgnoredDirectoryArgs()).toEqual([
      "ls-files",
      "--full-name",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
  });

  test("parses only NUL-delimited collapsed directories into unique absolute roots", () => {
    const repoRoot = resolve(tmpdir(), "hunk-ignored-parser");

    expect(
      parseGitIgnoredDirectoryRoots(
        ["dependencies/", "ignored.log", "build/nested/", "dependencies/", ""].join("\0"),
        repoRoot,
      ),
    ).toEqual([resolve(repoRoot, "dependencies"), resolve(repoRoot, "build/nested")]);
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

describe("listGitIgnoredDirectoryRoots", () => {
  test("collapses a dependency-heavy ignored tree without pruning nonignored paths", () => {
    const repoRoot = createTempRepo("hunk-git-ignored-dependencies-");
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\nignored.log\n");
    for (let index = 0; index < 25; index += 1) {
      const packageRoot = join(repoRoot, "node_modules", `package-${index}`, "cache");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "index.js"), `${index}\n`);
    }
    writeFileSync(join(repoRoot, "ignored.log"), "ignored file\n");
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    writeFileSync(join(repoRoot, "src", "untracked.ts"), "export {};\n");

    const roots = listGitIgnoredDirectoryRoots(makeGitInput(), { cwd: join(repoRoot, "src") });

    expect(roots).toEqual([join(realpathSync(repoRoot), "node_modules")]);
    expect(roots).not.toContain(join(realpathSync(repoRoot), "src"));
  });

  test("honors nested ignore negation instead of pruning its visible ancestor", () => {
    const repoRoot = createTempRepo("hunk-git-ignored-negation-");
    writeFileSync(
      join(repoRoot, ".gitignore"),
      ["generated/*", "!generated/.gitignore", "!generated/keep/", ""].join("\n"),
    );
    mkdirSync(join(repoRoot, "generated", "discard"), { recursive: true });
    mkdirSync(join(repoRoot, "generated", "keep"), { recursive: true });
    writeFileSync(
      join(repoRoot, "generated", ".gitignore"),
      ["keep/*", "!keep/visible.txt", ""].join("\n"),
    );
    writeFileSync(join(repoRoot, "generated", "discard", "output.js"), "ignored\n");
    writeFileSync(join(repoRoot, "generated", "keep", "hidden.txt"), "ignored file\n");
    writeFileSync(join(repoRoot, "generated", "keep", "visible.txt"), "visible\n");

    expect(listGitIgnoredDirectoryRoots(makeGitInput(), { cwd: repoRoot })).toEqual([
      join(realpathSync(repoRoot), "generated", "discard"),
    ]);
  });

  test("honors repository-local excludes", () => {
    const repoRoot = createTempRepo("hunk-git-ignored-info-exclude-");
    writeFileSync(join(repoRoot, ".git", "info", "exclude"), "local-cache/\n");
    mkdirSync(join(repoRoot, "local-cache", "nested"), { recursive: true });
    writeFileSync(join(repoRoot, "local-cache", "nested", "data"), "ignored\n");

    expect(listGitIgnoredDirectoryRoots(makeGitInput(), { cwd: repoRoot })).toEqual([
      join(realpathSync(repoRoot), "local-cache"),
    ]);
  });

  test("does not prune an ignored parent containing a forced tracked file", () => {
    const repoRoot = createTempRepo("hunk-git-ignored-tracked-");
    writeFileSync(join(repoRoot, ".gitignore"), "vendor/\n");
    mkdirSync(join(repoRoot, "vendor", "generated"), { recursive: true });
    writeFileSync(join(repoRoot, "vendor", "tracked.txt"), "tracked\n");
    writeFileSync(join(repoRoot, "vendor", "generated", "output.txt"), "ignored\n");
    git(repoRoot, "add", ".gitignore");
    git(repoRoot, "add", "-f", "vendor/tracked.txt");
    git(repoRoot, "commit", "-m", "track forced file");

    const roots = listGitIgnoredDirectoryRoots(makeGitInput(), { cwd: repoRoot });
    const trackedPath = join(realpathSync(repoRoot), "vendor", "tracked.txt");

    expect(roots).toEqual([join(realpathSync(repoRoot), "vendor", "generated")]);
    expect(roots.some((root) => trackedPath.startsWith(`${root}${sep}`))).toBe(false);
  });

  test("falls back to no pruning when best-effort discovery fails", () => {
    expect(
      listGitIgnoredDirectoryRoots(makeGitInput(), {
        cwd: tmpdir(),
        repoRoot: tmpdir(),
        gitExecutable: "definitely-not-a-real-git-binary",
      }),
    ).toEqual([]);
  });
});

describe("resolveGitMetadata", () => {
  test("resolves normal and linked-worktree metadata directories", () => {
    const repoRoot = createTempRepo("hunk-git-metadata-");
    writeFileSync(join(repoRoot, "x.txt"), "x\n");
    git(repoRoot, "add", "x.txt");
    git(repoRoot, "commit", "-m", "initial");

    const normal = resolveGitMetadata(makeGitInput(), { cwd: repoRoot });
    expect(normal.repoRoot).toBe(realpathSync(repoRoot));
    expect(normal.gitDir).toBe(normal.commonDir);

    const linkedRoot = mkdtempSync(join(tmpdir(), "hunk-git-linked-"));
    tempDirs.push(linkedRoot);
    git(repoRoot, "worktree", "add", linkedRoot, "-b", "linked-test");
    const linked = resolveGitMetadata(makeGitInput(), { cwd: linkedRoot });
    expect(linked.repoRoot).toBe(realpathSync(linkedRoot));
    expect(linked.gitDir).not.toBe(linked.commonDir);
    expect(linked.gitDir).toContain(join("worktrees", "hunk-git-linked-"));
    expect(linked.commonDir).toBe(normal.commonDir);
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
