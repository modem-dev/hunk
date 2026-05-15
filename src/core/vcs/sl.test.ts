import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { slAdapter } from "./sl";
import type { ShowCommandInput, StashShowCommandInput, VcsCommandInput } from "../types";

const slAvailable =
  Bun.spawnSync(["sl", "version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    .exitCode === 0;
const tempDirs: string[] = [];
const SlAdapterIntegrationTestTimeoutMs = 20_000;

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

function sl(cwd: string, ...cmd: string[]) {
  const proc = Bun.spawnSync(["sl", "--noninteractive", "--color", "never", ...cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr).toString("utf8");
    throw new Error(stderr.trim() || `sl ${cmd.join(" ")} failed`);
  }

  return Buffer.from(proc.stdout).toString("utf8");
}

function createTempSlRepo(prefix: string) {
  const dir = createTempDir(prefix);
  sl(dir, "init", "--git");
  sl(dir, "config", "--local", "ui.username", "Test User <test@example.com>");
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

describe("slAdapter", () => {
  test("detects Sapling repositories from nested directories", () => {
    const repo = createTempDir("hunk-sl-adapter-detect-");
    mkdirSync(join(repo, ".sl"));
    const nested = join(repo, "src", "nested");
    mkdirSync(nested, { recursive: true });

    expect(slAdapter.detect(nested)).toEqual({ id: "sl", repoRoot: repo });
  });

  test("auto-detects .hg directories with treestate as Sapling", () => {
    const repo = createTempDir("hunk-sl-adapter-hg-treestate-");
    mkdirSync(join(repo, ".hg"));
    writeFileSync(join(repo, ".hg", "requires"), "revlogv1\nstore\ntreestate\n");

    expect(slAdapter.detect(repo)).toEqual({ id: "sl", repoRoot: repo });
  });

  test("does not auto-detect .hg directories without treestate", () => {
    const repo = createTempDir("hunk-sl-adapter-hg-upstream-");
    mkdirSync(join(repo, ".hg"));
    writeFileSync(join(repo, ".hg", "requires"), "revlogv1\nstore\n");

    expect(slAdapter.detect(repo)).toBeNull();
  });

  test.skipIf(!slAvailable)(
    "loads working-copy and revision patches through neutral operations",
    async () => {
      const repo = createTempSlRepo("hunk-sl-adapter-review-");
      writeFileSync(join(repo, "file.txt"), "one\n");
      sl(repo, "add", "file.txt");
      sl(repo, "commit", "-m", "initial");
      writeFileSync(join(repo, "file.txt"), "two\n");

      const diffInput = {
        kind: "vcs",
        staged: false,
        options: { vcs: "sl" },
      } satisfies VcsCommandInput;
      const diffResult = await slAdapter.loadReview(
        { kind: "working-tree-diff", input: diffInput },
        { cwd: repo },
      );

      expect(normalizeComparablePath(diffResult.repoRoot)).toBe(normalizeComparablePath(repo));
      expect(diffResult.title).toContain("working copy");
      expect(diffResult.patchText).toContain("diff --git a/file.txt b/file.txt");
      expect(diffResult.patchText).toContain("+two");

      const showInput = {
        kind: "show",
        ref: ".",
        options: { vcs: "sl" },
      } satisfies ShowCommandInput;
      const showResult = await slAdapter.loadReview(
        { kind: "revision-show", input: showInput },
        { cwd: repo },
      );

      expect(showResult.title).toContain("show .");
      expect(showResult.patchText).toContain("diff --git a/file.txt b/file.txt");
    },
    SlAdapterIntegrationTestTimeoutMs,
  );

  test.skipIf(!slAvailable)(
    "rejects staged and stash operations",
    async () => {
      const repo = createTempSlRepo("hunk-sl-adapter-unsupported-");
      const stagedInput = {
        kind: "vcs",
        staged: true,
        options: { vcs: "sl" },
      } satisfies VcsCommandInput;
      const stashInput = {
        kind: "stash-show",
        options: { vcs: "sl" },
      } satisfies StashShowCommandInput;

      await expect(
        slAdapter.loadReview({ kind: "working-tree-diff", input: stagedInput }, { cwd: repo }),
      ).rejects.toThrow("Sapling has no staging area");
      await expect(
        slAdapter.loadReview({ kind: "stash-show", input: stashInput }, { cwd: repo }),
      ).rejects.toThrow("requires Git VCS mode");
    },
    SlAdapterIntegrationTestTimeoutMs,
  );
});
