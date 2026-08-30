import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { JjVcsAdapter } from ".";
import type {
  ExtensionVcsOperations,
  ExtensionVcsShowInput,
  ExtensionVcsDiffInput,
} from "hunkdiff/extension";

// The adapter is written against the published contract, so the tests read it
// through that contract too — including the operations an adapter may omit.
const jjOperations: ExtensionVcsOperations = JjVcsAdapter.operations;

const tempDirs: string[] = [];
const JjAdapterIntegrationTestTimeoutMs = 20_000;

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

function jj(cwd: string, ...cmd: string[]) {
  const proc = Bun.spawnSync(
    [
      "jj",
      "--config",
      "signing.behavior=drop",
      "--config",
      'user.name="Test User"',
      "--config",
      "user.email=test@example.com",
      ...cmd,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `jj ${cmd.join(" ")} failed`);
  }

  return Buffer.from(proc.stdout).toString("utf8");
}

function createTempJjRepo(prefix: string) {
  const dir = createTempDir(prefix);
  jj(tmpdir(), "git", "init", "--colocate", dir);
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

// Keep jj-backed adapter coverage opt-in on machines that have the external CLI installed.
const jjTest = Bun.which("jj") ? test : test.skip;

describe("JjVcsAdapter", () => {
  jjTest(
    "detects Jujutsu repositories from nested directories",
    () => {
      const repo = createTempJjRepo("hunk-jj-adapter-detect-");
      const nested = join(repo, "src", "nested");
      mkdirSync(nested, { recursive: true });

      expect(JjVcsAdapter.detect(nested)).toEqual({ id: "jj", repoRoot: repo });
    },
    JjAdapterIntegrationTestTimeoutMs,
  );

  jjTest("rejects option-like endpoints from direct adapter callers", async () => {
    const repo = createTempJjRepo("hunk-jj-adapter-endpoint-trust-");
    const input = {
      kind: "vcs",
      rangeEndpoints: { from: "main", to: "--at-operation" },
      staged: false,
      options: {},
    } satisfies ExtensionVcsDiffInput;

    await expect(
      JjVcsAdapter.operations["working-tree-diff"]!.load(input, { cwd: repo }),
    ).rejects.toThrow("looks like a Jujutsu option");
  });

  jjTest(
    "loads working-copy and revision patches through neutral operations",
    async () => {
      const repo = createTempJjRepo("hunk-jj-adapter-review-");
      writeFileSync(join(repo, "file.txt"), "one\n");
      jj(repo, "commit", "-m", "initial");
      writeFileSync(join(repo, "file.txt"), "two\n");

      const diffInput = {
        kind: "vcs",
        staged: false,
        options: {},
      } satisfies ExtensionVcsDiffInput;
      const diffResult = await JjVcsAdapter.operations["working-tree-diff"]!.load(diffInput, {
        cwd: repo,
      });

      expect(normalizeComparablePath(diffResult.repoRoot)).toBe(normalizeComparablePath(repo));
      expect(diffResult.title).toContain("working copy");
      expect(diffResult.patchText).toContain("diff --git a/file.txt b/file.txt");
      expect(diffResult.patchText).toContain("+two");
      expect(diffResult.sourceCacheKey).toContain("jj-source-v1");
      const reviewedFile = {
        path: "file.txt",
        changeType: "change",
        isUntracked: false,
      } as const;
      expect(await diffResult.readFileSource?.({ ...reviewedFile, side: "old" })).toBe("one\n");
      expect(await diffResult.readFileSource?.({ ...reviewedFile, side: "new" })).toBe("two\n");
      const equivalentDiffResult = await JjVcsAdapter.operations["working-tree-diff"]!.load(
        diffInput,
        { cwd: repo },
      );
      expect(equivalentDiffResult.sourceCacheKey).toBe(diffResult.sourceCacheKey);

      const showInput = {
        kind: "show",
        ref: "@",
        options: {},
      } satisfies ExtensionVcsShowInput;
      const showResult = await JjVcsAdapter.operations["revision-show"]!.load(showInput, {
        cwd: repo,
      });

      expect(showResult.title).toContain("show @");
      expect(showResult.patchText).toContain("diff --git a/file.txt b/file.txt");
      expect(showResult.sourceCacheKey).toContain("jj-source-v1");
      expect(await showResult.readFileSource?.({ ...reviewedFile, side: "old" })).toBe("one\n");
      expect(await showResult.readFileSource?.({ ...reviewedFile, side: "new" })).toBe("two\n");

      // Lazy source reads stay attached to the revision that produced the patch,
      // even after `@` is resnapshotted with different working-copy contents.
      writeFileSync(join(repo, "file.txt"), "three\n");
      jj(repo, "status");
      expect(await showResult.readFileSource?.({ ...reviewedFile, side: "new" })).toBe("two\n");
      const changedDiffResult = await JjVcsAdapter.operations["working-tree-diff"]!.load(
        diffInput,
        {
          cwd: repo,
        },
      );
      expect(changedDiffResult.sourceCacheKey).not.toBe(diffResult.sourceCacheKey);

      expect(
        JjVcsAdapter.operations["working-tree-diff"]!.watchSignature!(diffInput, { cwd: repo }),
      ).toContain("+three");
      expect(
        JjVcsAdapter.operations["revision-show"]!.watchSignature!(showInput, { cwd: repo }),
      ).toContain("diff --git");
    },
    JjAdapterIntegrationTestTimeoutMs,
  );

  jjTest(
    "expands source from both explicit revision endpoints",
    async () => {
      const repo = createTempJjRepo("hunk-jj-adapter-two-revisions-");
      writeFileSync(join(repo, "file.txt"), "one\ncontext\n");
      jj(repo, "commit", "-m", "first");
      const from = jj(repo, "log", "--no-graph", "-r", "@-", "-T", "commit_id");
      writeFileSync(join(repo, "file.txt"), "two\ncontext\n");
      const input = {
        kind: "vcs",
        staged: false,
        rangeEndpoints: { from, to: "@" },
        options: {},
      } satisfies ExtensionVcsDiffInput;

      const result = await JjVcsAdapter.operations["working-tree-diff"]!.load(input, { cwd: repo });
      const file = { path: "file.txt", changeType: "change", isUntracked: false } as const;
      expect(result.title).toContain(`${from}..@`);
      expect(result.patchText).toContain("+two");
      expect(await result.readFileSource?.({ ...file, side: "old" })).toBe("one\ncontext\n");
      expect(await result.readFileSource?.({ ...file, side: "new" })).toBe("two\ncontext\n");

      writeFileSync(join(repo, "file.txt"), "three\ncontext\n");
      expect(
        JjVcsAdapter.operations["working-tree-diff"]!.watchSignature!(input, { cwd: repo }),
      ).toContain("+three");
    },
    JjAdapterIntegrationTestTimeoutMs,
  );

  jjTest(
    "preserves nested cwd filesets across loaded patches and watch signatures",
    async () => {
      const repo = createTempJjRepo("hunk-jj-adapter-nested-cwd-");
      const nested = join(repo, "sub");
      mkdirSync(nested);
      writeFileSync(join(repo, "file.txt"), "root old\n");
      writeFileSync(join(nested, "file.txt"), "nested old\n");
      jj(repo, "commit", "-m", "initial");
      writeFileSync(join(repo, "file.txt"), "root new\n");
      writeFileSync(join(nested, "file.txt"), "nested new\n");

      const diffInput = {
        kind: "vcs",
        staged: false,
        pathspecs: ["file.txt"],
        options: {},
      } satisfies ExtensionVcsDiffInput;
      const showInput = {
        kind: "show",
        ref: "@",
        pathspecs: ["file.txt"],
        options: {},
      } satisfies ExtensionVcsShowInput;
      const diffResult = await JjVcsAdapter.operations["working-tree-diff"]!.load(diffInput, {
        cwd: nested,
      });
      const showResult = await JjVcsAdapter.operations["revision-show"]!.load(showInput, {
        cwd: nested,
      });
      const patchTexts = [
        diffResult.patchText,
        JjVcsAdapter.operations["working-tree-diff"]!.watchSignature!(diffInput, { cwd: nested }),
        showResult.patchText,
        JjVcsAdapter.operations["revision-show"]!.watchSignature!(showInput, { cwd: nested }),
      ];

      for (const patchText of patchTexts) {
        expect(patchText).toContain("sub/file.txt");
        expect(patchText).toContain("+nested new");
        expect(patchText).not.toContain("+root new");
      }

      const reviewedFile = {
        path: "sub/file.txt",
        changeType: "change",
        isUntracked: false,
      } as const;
      expect(await showResult.readFileSource?.({ ...reviewedFile, side: "old" })).toBe(
        "nested old\n",
      );
      expect(await showResult.readFileSource?.({ ...reviewedFile, side: "new" })).toBe(
        "nested new\n",
      );
    },
    JjAdapterIntegrationTestTimeoutMs,
  );

  jjTest(
    "ignores a shadowing parents alias when loading the old source",
    async () => {
      const repo = createTempJjRepo("hunk-jj-adapter-parent-alias-");
      writeFileSync(join(repo, "file.txt"), "grandparent version\ncontext\n");
      jj(repo, "commit", "-m", "grandparent");
      writeFileSync(join(repo, "file.txt"), "parent version\ncontext\n");
      jj(repo, "commit", "-m", "parent");
      writeFileSync(join(repo, "file.txt"), "child version\ncontext\n");
      jj(repo, "config", "set", "--repo", 'revset-aliases."parents(x)"', "x--");

      const result = await JjVcsAdapter.operations["revision-show"]!.load(
        { kind: "show", ref: "@", options: {} },
        { cwd: repo },
      );
      const reviewedFile = {
        path: "file.txt",
        changeType: "change",
        isUntracked: false,
      } as const;

      expect(result.patchText).toContain("-parent version");
      expect(result.patchText).not.toContain("-grandparent version");
      expect(await result.readFileSource?.({ ...reviewedFile, side: "old" })).toBe(
        "parent version\ncontext\n",
      );
      expect(await result.readFileSource?.({ ...reviewedFile, side: "new" })).toBe(
        "child version\ncontext\n",
      );
    },
    JjAdapterIntegrationTestTimeoutMs,
  );

  jjTest(
    "reads rename, addition, and deletion sides from their exact paths",
    async () => {
      const repo = createTempJjRepo("hunk-jj-adapter-source-kinds-");
      writeFileSync(join(repo, "old-name.txt"), "old name\n");
      writeFileSync(join(repo, "deleted.txt"), "deleted source\n");
      jj(repo, "commit", "-m", "initial");

      renameSync(join(repo, "old-name.txt"), join(repo, "new-name.txt"));
      writeFileSync(join(repo, "new-name.txt"), "renamed source\n");
      writeFileSync(join(repo, "added.txt"), "added source\n");
      rmSync(join(repo, "deleted.txt"));

      const result = await JjVcsAdapter.operations["revision-show"]!.load(
        { kind: "show", ref: "@", options: {} },
        { cwd: repo },
      );
      const readSource = result.readFileSource!;

      expect(
        await readSource({
          path: "new-name.txt",
          previousPath: "old-name.txt",
          changeType: "rename-changed",
          isUntracked: false,
          side: "old",
        }),
      ).toBe("old name\n");
      expect(
        await readSource({
          path: "new-name.txt",
          previousPath: "old-name.txt",
          changeType: "rename-changed",
          isUntracked: false,
          side: "new",
        }),
      ).toBe("renamed source\n");
      expect(
        await readSource({
          path: "added.txt",
          changeType: "new",
          isUntracked: false,
          side: "old",
        }),
      ).toBeNull();
      expect(
        await readSource({
          path: "added.txt",
          changeType: "new",
          isUntracked: false,
          side: "new",
        }),
      ).toBe("added source\n");
      expect(
        await readSource({
          path: "deleted.txt",
          changeType: "deleted",
          isUntracked: false,
          side: "old",
        }),
      ).toBe("deleted source\n");
      expect(
        await readSource({
          path: "deleted.txt",
          changeType: "deleted",
          isUntracked: false,
          side: "new",
        }),
      ).toBeNull();
    },
    JjAdapterIntegrationTestTimeoutMs,
  );

  jjTest(
    "preserves multi-revision patches without attaching guessed sources",
    async () => {
      const repo = createTempJjRepo("hunk-jj-adapter-multi-");
      writeFileSync(join(repo, "file.txt"), "one\n");
      jj(repo, "commit", "-m", "first");
      writeFileSync(join(repo, "file.txt"), "two\n");
      jj(repo, "commit", "-m", "second");
      const revset = "@- | @--";

      const diffResult = await JjVcsAdapter.operations["working-tree-diff"]!.load(
        { kind: "vcs", staged: false, range: revset, options: {} },
        { cwd: repo },
      );
      const showResult = await JjVcsAdapter.operations["revision-show"]!.load(
        { kind: "show", ref: revset, options: {} },
        { cwd: repo },
      );

      expect(diffResult.patchText).toContain("diff --git");
      expect(showResult.patchText).toBe(diffResult.patchText);
      expect(diffResult.readFileSource).toBeUndefined();
      expect(diffResult.sourceCacheKey).toBeUndefined();
      expect(showResult.readFileSource).toBeUndefined();
      expect(showResult.sourceCacheKey).toBeUndefined();
    },
    JjAdapterIntegrationTestTimeoutMs,
  );

  jjTest(
    "expands a merge from its exact new side without guessing the merged-parent source",
    async () => {
      const repo = createTempJjRepo("hunk-jj-adapter-merge-");
      writeFileSync(join(repo, "file.txt"), "base\n");
      jj(repo, "commit", "-m", "base");
      const baseCommitId = jj(repo, "log", "--no-graph", "-r", "@-", "-T", "commit_id");

      writeFileSync(join(repo, "left.txt"), "left\n");
      jj(repo, "commit", "-m", "left");
      const leftCommitId = jj(repo, "log", "--no-graph", "-r", "@-", "-T", "commit_id");

      jj(repo, "new", baseCommitId);
      writeFileSync(join(repo, "right.txt"), "right\n");
      jj(repo, "commit", "-m", "right");
      const rightCommitId = jj(repo, "log", "--no-graph", "-r", "@-", "-T", "commit_id");

      jj(repo, "new", leftCommitId, rightCommitId);
      writeFileSync(join(repo, "file.txt"), "merge result\n");
      const result = await JjVcsAdapter.operations["revision-show"]!.load(
        { kind: "show", ref: "@", options: {} },
        { cwd: repo },
      );
      const file = { path: "file.txt", changeType: "change", isUntracked: false } as const;

      expect(result.sourceCacheKey).toContain(
        `merged-parents:${[leftCommitId, rightCommitId].sort().join(",")}`,
      );
      expect(await result.readFileSource?.({ ...file, side: "old" })).toBeNull();
      expect(await result.readFileSource?.({ ...file, side: "new" })).toBe("merge result\n");
    },
    JjAdapterIntegrationTestTimeoutMs,
  );

  jjTest(
    "rejects staged and stash operations",
    async () => {
      const repo = createTempJjRepo("hunk-jj-adapter-unsupported-");
      const stagedInput = {
        kind: "vcs",
        staged: true,
        options: {},
      } satisfies ExtensionVcsDiffInput;
      await expect(
        JjVcsAdapter.operations["working-tree-diff"]!.load(stagedInput, { cwd: repo }),
      ).rejects.toThrow("Jujutsu has no staging area");
      expect(jjOperations["stash-show"]).toBeUndefined();
    },
    JjAdapterIntegrationTestTimeoutMs,
  );
});

// These branches run before any `jj` invocation, so they need no external binary.
describe("JjVcsAdapter without the jj binary", () => {
  test("detects a .jj workspace marker from a nested directory", () => {
    const repo = createTempDir("hunk-jj-detect-marker-");
    mkdirSync(join(repo, ".jj"));
    const nested = join(repo, "src", "nested");
    mkdirSync(nested, { recursive: true });

    expect(JjVcsAdapter.detect(nested)).toEqual({ id: "jj", repoRoot: repo });
  });

  test("returns null when no .jj marker exists up to the filesystem root", () => {
    expect(JjVcsAdapter.detect(createTempDir("hunk-jj-detect-none-"))).toBeNull();
  });

  test("rejects staged working-tree diffs before spawning jj", async () => {
    const stagedInput = {
      kind: "vcs",
      staged: true,
      options: {},
    } satisfies ExtensionVcsDiffInput;
    await expect(
      JjVcsAdapter.operations["working-tree-diff"]!.load(stagedInput, { cwd: tmpdir() }),
    ).rejects.toThrow("Jujutsu has no staging area");
  });

  test("does not expose a stash-show operation", () => {
    expect(jjOperations["stash-show"]).toBeUndefined();
  });
});
