import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  resolvePersistedReviewCommentsPath,
  writePersistedReviewComments,
} from "./persistedComments";
import type { SessionReviewNoteSummary } from "../../session/types";

const tempDirs: string[] = [];

// Hosted Windows runners can spend several seconds starting each real Git process.
setDefaultTimeout(30_000);

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

function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createTempRepo(prefix: string) {
  const dir = createTempDir(prefix);
  git(dir, "init");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgSign", "false");
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createNoteSummary(overrides: Partial<SessionReviewNoteSummary> = {}) {
  return {
    noteId: "user:1-1",
    source: "user",
    filePath: "src/example.ts",
    hunkIndex: 0,
    newRange: [10, 10],
    body: "Rename this variable.",
    author: "user",
    createdAt: "2026-09-01T00:00:00.000Z",
    editable: true,
    ...overrides,
  } satisfies SessionReviewNoteSummary;
}

describe("resolvePersistedReviewCommentsPath", () => {
  test("resolves under the repository's git directory", () => {
    const repo = createTempRepo("hunk-persist-repo-");

    const path = resolvePersistedReviewCommentsPath(repo);

    expect(path).toBe(
      join(git(repo, "rev-parse", "--absolute-git-dir").trim(), "hunk", "review-comments.json"),
    );
  });

  test("resolves a linked worktree to its own metadata directory", () => {
    const repo = createTempRepo("hunk-persist-main-");
    writeFileSync(join(repo, "file.txt"), "one\n");
    git(repo, "add", "file.txt");
    git(repo, "commit", "-m", "initial");
    const linked = mkdtempSync(join(tmpdir(), "hunk-persist-linked-"));
    tempDirs.push(linked);
    git(repo, "worktree", "add", linked, "-b", "linked-test");

    const path = resolvePersistedReviewCommentsPath(linked);

    expect(path?.split(sep)).toContain("worktrees");
    expect(path).not.toBe(resolvePersistedReviewCommentsPath(repo));
  });

  test("returns undefined outside a git repository", () => {
    const dir = createTempDir("hunk-persist-plain-");

    expect(resolvePersistedReviewCommentsPath(dir)).toBeUndefined();
  });
});

describe("writePersistedReviewComments", () => {
  test("creates the file with the session's notes and replaces it on later writes", () => {
    const dir = createTempDir("hunk-persist-write-");
    const filePath = join(dir, "hunk", "review-comments.json");

    writePersistedReviewComments(filePath, {
      updatedAt: "2026-09-01T00:00:00.000Z",
      sourceLabel: "git diff",
      reviewNotes: [createNoteSummary()],
    });
    writePersistedReviewComments(filePath, {
      updatedAt: "2026-09-01T00:01:00.000Z",
      sourceLabel: "git diff",
      reviewNotes: [],
    });

    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      updatedAt: "2026-09-01T00:01:00.000Z",
      sourceLabel: "git diff",
      reviewNotes: [],
    });
  });
});
