import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSourceFetcher } from "./fileSource";

const tempDirs: string[] = [];

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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
  git(dir, "init");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgSign", "false");
  return dir;
}

/** Capture console.error calls while exercising diagnostic paths. */
async function captureConsoleErrors(fn: () => Promise<void>) {
  const originalConsoleError = console.error;
  const loggedErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  try {
    await fn();
  } finally {
    console.error = originalConsoleError;
  }

  return loggedErrors;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("createFileSourceFetcher", () => {
  test("reads fs paths for old and new sides", async () => {
    const dir = createTempDir("hunk-source-fs-");
    const left = join(dir, "before.txt");
    const right = join(dir, "after.txt");
    writeFileSync(left, "old contents\n");
    writeFileSync(right, "new contents\n");

    const fetcher = createFileSourceFetcher({
      old: { kind: "fs", absolutePath: left },
      new: { kind: "fs", absolutePath: right },
    });

    expect(await fetcher.getFullText("old")).toBe("old contents\n");
    expect(await fetcher.getFullText("new")).toBe("new contents\n");
  });

  test("returns null for `none` specs", async () => {
    const fetcher = createFileSourceFetcher({
      old: { kind: "none" },
      new: { kind: "none" },
    });

    expect(await fetcher.getFullText("old")).toBeNull();
    expect(await fetcher.getFullText("new")).toBeNull();
  });

  test("returns null when an fs path cannot be read", async () => {
    const dir = createTempDir("hunk-source-fs-missing-");
    const fetcher = createFileSourceFetcher({
      old: { kind: "fs", absolutePath: join(dir, "missing.txt") },
      new: { kind: "none" },
    });

    expect(await fetcher.getFullText("old")).toBeNull();
  });

  test("reads git blob contents for both sides via `git show`", async () => {
    const repoRoot = createTempRepo("hunk-source-git-");
    const filePath = "note.txt";

    writeFileSync(join(repoRoot, filePath), "first revision\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-m", "first");
    writeFileSync(join(repoRoot, filePath), "second revision\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-m", "second");

    const fetcher = createFileSourceFetcher({
      old: { kind: "git-blob", repoRoot, ref: "HEAD~1", path: filePath },
      new: { kind: "git-blob", repoRoot, ref: "HEAD", path: filePath },
    });

    expect(await fetcher.getFullText("old")).toBe("first revision\n");
    expect(await fetcher.getFullText("new")).toBe("second revision\n");
  });

  test("reads git index contents through an explicit index spec", async () => {
    const repoRoot = createTempRepo("hunk-source-git-index-");
    const filePath = "note.txt";

    writeFileSync(join(repoRoot, filePath), "committed\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-m", "first");
    writeFileSync(join(repoRoot, filePath), "staged\n");
    git(repoRoot, "add", filePath);
    writeFileSync(join(repoRoot, filePath), "working tree\n");

    const fetcher = createFileSourceFetcher({
      old: { kind: "git-index", repoRoot, path: filePath },
      new: { kind: "fs", absolutePath: join(repoRoot, filePath) },
    });

    expect(await fetcher.getFullText("old")).toBe("staged\n");
    expect(await fetcher.getFullText("new")).toBe("working tree\n");
  });

  test("returns null when a git blob cannot be resolved", async () => {
    const repoRoot = createTempRepo("hunk-source-git-missing-");
    writeFileSync(join(repoRoot, "tracked.txt"), "x\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-m", "first");

    const fetcher = createFileSourceFetcher({
      old: { kind: "git-blob", repoRoot, ref: "HEAD", path: "missing-from-history.txt" },
      new: { kind: "none" },
    });

    const loggedErrors = await captureConsoleErrors(async () => {
      expect(await fetcher.getFullText("old")).toBeNull();
    });
    expect(loggedErrors).toHaveLength(0);
  });

  test("logs unexpected git source failures with object context", async () => {
    const repoRoot = createTempDir("hunk-source-git-not-repo-");
    const fetcher = createFileSourceFetcher({
      old: { kind: "git-blob", repoRoot, ref: "HEAD", path: "note.txt" },
      new: { kind: "none" },
    });

    const loggedErrors = await captureConsoleErrors(async () => {
      expect(await fetcher.getFullText("old")).toBeNull();
    });

    expect(loggedErrors).toHaveLength(1);
    expect(String(loggedErrors[0]?.[0])).toContain("HEAD:note.txt");
    expect(String(loggedErrors[0]?.[0])).toContain(repoRoot);
  });

  test("caches resolved text per side", async () => {
    const dir = createTempDir("hunk-source-cache-");
    const target = join(dir, "value.txt");
    writeFileSync(target, "first\n");

    const fetcher = createFileSourceFetcher({
      old: { kind: "none" },
      new: { kind: "fs", absolutePath: target },
    });

    const initial = await fetcher.getFullText("new");
    writeFileSync(target, "rewritten\n");
    const cached = await fetcher.getFullText("new");

    expect(initial).toBe("first\n");
    expect(cached).toBe("first\n");
  });
});
