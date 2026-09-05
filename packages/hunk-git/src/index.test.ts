import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { GitVcsAdapter, statSignature } from ".";
import type {
  ExtensionVcsDiffInput,
  ExtensionVcsOperations,
  ExtensionVcsShowInput,
  ExtensionVcsStashShowInput,
} from "hunkdiff/extension";

// The adapter is written against the published contract, so the tests read it
// through that contract too — including the capabilities Git is the only
// bundled backend to use.
const gitOperations: ExtensionVcsOperations = GitVcsAdapter.operations;

// Hosted Windows runners can spend several seconds starting each real Git process.
// Keep this integration-like adapter suite bounded without using Bun's five-second default.
setDefaultTimeout(30_000);

describe("GitVcsAdapter published surface", () => {
  test("implements every review operation the contract defines", () => {
    expect(gitOperations["working-tree-diff"]).toBeDefined();
    expect(gitOperations["revision-show"]).toBeDefined();
    expect(gitOperations["stash-show"]).toBeDefined();
    // Git is the detection baseline every other backend positions against.
    expect(GitVcsAdapter.detectionPriority).toBe(0);
  });
});

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

  test("rejects option-like endpoints from direct adapter callers", async () => {
    const repo = createTempRepo("hunk-git-adapter-endpoint-trust-");
    const input = {
      kind: "vcs",
      rangeEndpoints: { from: "main", to: "--output=unsafe" },
      staged: false,
      options: {},
    } satisfies ExtensionVcsDiffInput;

    await expect(
      GitVcsAdapter.operations["working-tree-diff"]!.load(input, { cwd: repo }),
    ).rejects.toThrow("looks like a Git option");
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
      options: {},
    } satisfies ExtensionVcsDiffInput;
    const result = await GitVcsAdapter.operations["working-tree-diff"]!.load(input, { cwd: repo });

    expect(normalizeComparablePath(result.repoRoot)).toBe(normalizeComparablePath(repo));
    expect(result.title).toContain("working tree");
    expect(result.patchText).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patchText).toContain("+new");
    expect(result.untrackedPaths).toContain("untracked.txt");
    expect(result.sourceCacheKey).toContain("git-source-v1");

    const equivalentResult = await GitVcsAdapter.operations["working-tree-diff"]!.load(input, {
      cwd: repo,
    });
    expect(equivalentResult.sourceCacheKey).toBe(result.sourceCacheKey);

    const readSource = result.readFileSource;
    expect(readSource).toBeDefined();
    const trackedFile = { path: "tracked.txt", changeType: "change", isUntracked: false } as const;
    expect(await readSource?.({ ...trackedFile, side: "old" })).toBe("old\n");
    expect(await readSource?.({ ...trackedFile, side: "new" })).toBe("new\n");

    git(repo, "add", "tracked.txt");
    const changedIndexResult = await GitVcsAdapter.operations["working-tree-diff"]!.load(input, {
      cwd: repo,
    });
    expect(changedIndexResult.sourceCacheKey).not.toBe(result.sourceCacheKey);

    // Untracked files come back as paths for Hunk to synthesize in-process:
    // one `git status` covers all of them instead of one `git diff --no-index`
    // subprocess per file, which made review scale with the untracked count.
    expect(result.extraFiles ?? []).toHaveLength(0);
  });

  test("loads two-revision diffs with exact sources and no working-tree untracked files", async () => {
    const repo = createTempRepo("hunk-git-adapter-two-revisions-");
    writeFileSync(join(repo, "tracked.txt"), "old\ncontext\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-m", "old");
    const from = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "tracked.txt"), "new\ncontext\n");
    git(repo, "commit", "-am", "new");
    const to = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "untracked.txt"), "not part of either revision\n");

    const input = {
      kind: "vcs",
      staged: false,
      rangeEndpoints: { from, to },
      options: {},
    } satisfies ExtensionVcsDiffInput;
    const result = await GitVcsAdapter.operations["working-tree-diff"]!.load(input, { cwd: repo });
    const file = { path: "tracked.txt", changeType: "change", isUntracked: false } as const;

    expect(result.title).toContain(`${from}..${to}`);
    expect(result.untrackedPaths).toEqual([]);
    expect(await result.readFileSource?.({ ...file, side: "old" })).toBe("old\ncontext\n");
    expect(await result.readFileSource?.({ ...file, side: "new" })).toBe("new\ncontext\n");
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
      options: {},
    } satisfies ExtensionVcsShowInput;
    const showResult = await GitVcsAdapter.operations["revision-show"]!.load(showInput, {
      cwd: repo,
    });

    expect(showResult.title).toContain("show HEAD");
    expect(showResult.patchText).toContain("diff --git a/file.txt b/file.txt");
    expect(showResult.patchText).toContain("+two");
    expect(showResult.sourceCacheKey).toContain("git-source-v1");

    const showFile = { path: "file.txt", changeType: "change", isUntracked: false } as const;
    expect(await showResult.readFileSource?.({ ...showFile, side: "old" })).toBe("one\n");
    expect(await showResult.readFileSource?.({ ...showFile, side: "new" })).toBe("two\n");

    writeFileSync(join(repo, "file.txt"), "three\n");
    git(repo, "stash", "push", "-m", "adapter stash");

    const stashInput = {
      kind: "stash-show",
      options: {},
    } satisfies ExtensionVcsStashShowInput;
    const stashResult = await GitVcsAdapter.operations["stash-show"]!.load(stashInput, {
      cwd: repo,
    });

    expect(stashResult.title).toContain("stash");
    expect(stashResult.patchText).toContain("diff --git a/file.txt b/file.txt");
    expect(stashResult.sourceCacheKey).toContain("git-source-v1");
    expect(stashResult.patchText).toContain("+three");
  });

  test("returns null when no Git marker exists up to the filesystem root", () => {
    // A bare temp dir has no .git in any ancestor, exercising the walk-to-root null return.
    expect(GitVcsAdapter.detect(createTempDir("hunk-git-adapter-none-"))).toBeNull();
  });

  test("builds operation-sensitive watch plans for working tree and metadata reviews", () => {
    const repo = createTempRepo("hunk-git-adapter-plan-");
    writeFileSync(join(repo, "file.txt"), "one\n");
    writeFileSync(join(repo, ".gitignore"), "generated/\n");
    git(repo, "add", "file.txt", ".gitignore");
    git(repo, "commit", "-m", "initial");
    mkdirSync(join(repo, "generated", "nested"), { recursive: true });
    writeFileSync(join(repo, "generated", "nested", "output.js"), "ignored\n");

    const operation = GitVcsAdapter.operations["working-tree-diff"]!;
    const unstaged = operation.watchPlan!(
      { kind: "vcs", staged: false, options: {} },
      { cwd: repo },
    );
    expect(
      unstaged.targets.some(
        (target) => normalizeComparablePath(target.directory) === normalizeComparablePath(repo),
      ),
    ).toBe(true);
    const worktreeTarget = unstaged.targets.find(
      (target) =>
        target.kind === "directory-tree" &&
        normalizeComparablePath(target.directory) === normalizeComparablePath(repo),
    );
    expect(
      worktreeTarget?.kind === "directory-tree"
        ? worktreeTarget.ignoredRoots.map(normalizeComparablePath)
        : [],
    ).toEqual([
      normalizeComparablePath(join(repo, ".git")),
      normalizeComparablePath(join(repo, "generated")),
    ]);
    const metadataTargets = unstaged.targets.filter((target) =>
      target.sources.includes("vcs-metadata"),
    );
    expect(metadataTargets).toHaveLength(1);
    expect(normalizeComparablePath(metadataTargets[0]!.directory)).toBe(
      normalizeComparablePath(join(repo, ".git")),
    );
    expect(
      metadataTargets[0]!.kind === "directory-tree"
        ? metadataTargets[0]!.ignoredRoots.map(normalizeComparablePath)
        : [],
    ).toEqual([normalizeComparablePath(join(repo, ".git", "objects"))]);
    const refPlan = operation.watchPlan!(
      {
        kind: "vcs",
        staged: false,
        range: "HEAD",
        pathspecs: ["file.txt"],
        options: {},
      },
      { cwd: repo },
    );
    expect(
      refPlan.targets.some(
        (target) => normalizeComparablePath(target.directory) === normalizeComparablePath(repo),
      ),
    ).toBe(true);

    for (const input of [
      { kind: "vcs", staged: true, options: {} },
      { kind: "vcs", staged: false, range: "HEAD^..HEAD", options: {} },
    ] as ExtensionVcsDiffInput[]) {
      const plan = operation.watchPlan!(input, { cwd: repo });
      expect(
        plan.targets.some(
          (target) => normalizeComparablePath(target.directory) === normalizeComparablePath(repo),
        ),
      ).toBe(false);
      expect(plan.targets.some((target) => target.sources.includes("vcs-metadata"))).toBe(true);
    }
  });

  test("keeps stash reflogs observable for ordinal selectors", () => {
    const repo = createTempRepo("hunk-git-adapter-stash-plan-");
    const plan = GitVcsAdapter.operations["stash-show"]!.watchPlan!(
      { kind: "stash-show", ref: "stash@{1}", options: {} },
      { cwd: repo },
    );
    const metadataTarget = plan.targets.find((target) => target.sources.includes("vcs-metadata"));
    expect(normalizeComparablePath(metadataTarget!.directory)).toBe(
      normalizeComparablePath(join(repo, ".git")),
    );
    expect(
      metadataTarget?.kind === "directory-tree"
        ? metadataTarget.ignoredRoots.map(normalizeComparablePath)
        : [],
    ).toEqual([normalizeComparablePath(join(repo, ".git", "objects"))]);
  });

  test("deduplicates common metadata while covering linked-worktree state", () => {
    const repo = createTempRepo("hunk-git-adapter-linked-plan-");
    writeFileSync(join(repo, "file.txt"), "one\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-m", "initial");
    const linked = createTempDir("hunk-git-adapter-worktree-");
    git(repo, "worktree", "add", linked, "-b", "linked-plan");

    const plan = GitVcsAdapter.operations["revision-show"]!.watchPlan!(
      { kind: "show", ref: "HEAD", options: {} },
      { cwd: linked },
    );
    const metadataTargets = plan.targets.filter(
      (target) => target.kind === "directory-tree" && target.sources.includes("vcs-metadata"),
    );
    expect(metadataTargets).toHaveLength(1);
    const commonDirOutput = git(linked, "rev-parse", "--git-common-dir").trim();
    const commonDir = isAbsolute(commonDirOutput)
      ? commonDirOutput
      : resolve(linked, commonDirOutput);
    expect(normalizeComparablePath(metadataTargets[0]!.directory)).toBe(
      normalizeComparablePath(commonDir),
    );
    const metadataTarget = metadataTargets[0]!;
    expect(metadataTarget.kind === "directory-tree" ? metadataTarget.ignoredRoots : []).toEqual([
      join(metadataTarget.directory, "objects"),
    ]);
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
      { kind: "vcs", staged: false, options: {} },
      { cwd: repo },
    );
    expect(diffSignature).toContain("diff --git a/file.txt b/file.txt");
    expect(diffSignature).toContain("untracked:");

    const showSignature = GitVcsAdapter.operations["revision-show"]!.watchSignature!(
      { kind: "show", ref: "HEAD", options: {} },
      { cwd: repo },
    );
    expect(showSignature).toContain("diff --git");

    // Stash the dirty state so a stash entry exists for the stash-show signature.
    git(repo, "stash", "push", "--include-untracked", "-m", "watch stash");
    const stashSignature = GitVcsAdapter.operations["stash-show"]!.watchSignature!(
      { kind: "stash-show", options: {} },
      { cwd: repo },
    );
    expect(stashSignature).toContain("diff --git");
  });
});

describe("bundled Git adapter helpers", () => {
  test("statSignature distinguishes present from missing paths", () => {
    const repo = createTempDir("hunk-git-statsig-");
    const present = join(repo, "present.txt");
    writeFileSync(present, "data\n");
    expect(statSignature(present)).toContain(`${present}:`);
    expect(statSignature(present)).not.toContain(":missing");
    expect(statSignature(join(repo, "absent.txt"))).toBe(`${join(repo, "absent.txt")}:missing`);
  });
});
