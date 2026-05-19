import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { jjAdapter } from "./jj";
import type { ShowCommandInput, StashShowCommandInput, VcsCommandInput } from "../types";

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

describe("jjAdapter", () => {
  jjTest(
    "detects Jujutsu repositories from nested directories",
    () => {
      const repo = createTempJjRepo("hunk-jj-adapter-detect-");
      const nested = join(repo, "src", "nested");
      mkdirSync(nested, { recursive: true });

      expect(jjAdapter.detect(nested)).toEqual({ id: "jj", repoRoot: repo });
    },
    JjAdapterIntegrationTestTimeoutMs,
  );

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
        options: { vcs: "jj" },
      } satisfies VcsCommandInput;
      const diffResult = await jjAdapter.loadReview(
        { kind: "working-tree-diff", input: diffInput },
        { cwd: repo },
      );

      expect(normalizeComparablePath(diffResult.repoRoot)).toBe(normalizeComparablePath(repo));
      expect(diffResult.title).toContain("working copy");
      expect(diffResult.patchText).toContain("diff --git a/file.txt b/file.txt");
      expect(diffResult.patchText).toContain("+two");

      const showInput = {
        kind: "show",
        ref: "@",
        options: { vcs: "jj" },
      } satisfies ShowCommandInput;
      const showResult = await jjAdapter.loadReview(
        { kind: "revision-show", input: showInput },
        { cwd: repo },
      );

      expect(showResult.title).toContain("show @");
      expect(showResult.patchText).toContain("diff --git a/file.txt b/file.txt");
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
        options: { vcs: "jj" },
      } satisfies VcsCommandInput;
      const stashInput = {
        kind: "stash-show",
        options: { vcs: "jj" },
      } satisfies StashShowCommandInput;

      await expect(
        jjAdapter.loadReview({ kind: "working-tree-diff", input: stagedInput }, { cwd: repo }),
      ).rejects.toThrow("Jujutsu has no staging area");
      await expect(
        jjAdapter.loadReview({ kind: "stash-show", input: stashInput }, { cwd: repo }),
      ).rejects.toThrow("requires Git VCS mode");
    },
    JjAdapterIntegrationTestTimeoutMs,
  );
});
