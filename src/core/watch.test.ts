import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeWatchSignature } from "./watch";
import type { CliInput } from "./types";

const tempDirs: string[] = [];

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);

  git(dir, "init", "--initial-branch", "master");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");

  return dir;
}

function createGitInput({
  options,
  ...overrides
}: {
  options?: Partial<Extract<CliInput, { kind: "vcs" }>["options"]>;
} & Partial<Omit<Extract<CliInput, { kind: "vcs" }>, "kind" | "options">> = {}) {
  return {
    kind: "vcs",
    staged: false,
    ...overrides,
    options: {
      mode: "auto",
      ...options,
    },
  } satisfies Extract<CliInput, { kind: "vcs" }>;
}

afterEach(() => {
  cleanupTempDirs();
});

describe("computeWatchSignature", () => {
  test("resolves direct files, patch files, and agent sidecars against the supplied cwd", () => {
    const dir = createTempRepo("hunk-watch-files-cwd-");
    writeFileSync(join(dir, "left.ts"), "one\n");
    writeFileSync(join(dir, "right.ts"), "two\n");
    writeFileSync(join(dir, "review.patch"), "patch\n");
    writeFileSync(join(dir, "agent.json"), "{}\n");

    const direct = computeWatchSignature(
      {
        kind: "diff",
        left: "left.ts",
        right: "right.ts",
        options: { agentContext: "agent.json" },
      },
      { cwd: dir },
    );
    const patch = computeWatchSignature(
      { kind: "patch", file: "review.patch", options: {} },
      { cwd: dir },
    );

    expect(direct).toContain(join(dir, "left.ts"));
    expect(direct).toContain(join(dir, "right.ts"));
    expect(direct).toContain(join(dir, "agent.json"));
    expect(patch).toContain(join(dir, "review.patch"));
  });

  test("does not embed full untracked file contents in git watch signatures", () => {
    const dir = createTempRepo("hunk-watch-untracked-");

    writeFileSync(join(dir, "tracked.ts"), "export const tracked = 1;\n");
    git(dir, "add", "tracked.ts");
    git(dir, "commit", "-m", "initial");

    const largeMarker = "UNTRACKED-CONTENT-".repeat(1024);
    const untrackedPath = join(dir, "large-untracked.txt");
    writeFileSync(untrackedPath, largeMarker);

    const initialSignature = computeWatchSignature(createGitInput(), { cwd: dir });
    writeFileSync(untrackedPath, `${largeMarker}changed`);
    const changedSignature = computeWatchSignature(createGitInput(), { cwd: dir });

    expect(initialSignature).not.toContain(largeMarker);
    expect(changedSignature).not.toContain(largeMarker);
    expect(changedSignature).not.toEqual(initialSignature);
  });

  test("ignores untracked file changes when the git input excludes them", () => {
    const dir = createTempRepo("hunk-watch-exclude-untracked-");

    writeFileSync(join(dir, "tracked.ts"), "export const tracked = 1;\n");
    git(dir, "add", "tracked.ts");
    git(dir, "commit", "-m", "initial");

    const untrackedPath = join(dir, "note.txt");
    writeFileSync(untrackedPath, "first\n");

    const initialSignature = computeWatchSignature(
      createGitInput({ options: { excludeUntracked: true } }),
      { cwd: dir },
    );
    writeFileSync(untrackedPath, "second\n");
    const changedSignature = computeWatchSignature(
      createGitInput({ options: { excludeUntracked: true } }),
      { cwd: dir },
    );

    expect(changedSignature).toEqual(initialSignature);
  });

  test("rejects unsupported watch operations before invoking adapter signatures", () => {
    expect(() =>
      computeWatchSignature(
        {
          kind: "stash-show",
          options: { mode: "auto", vcs: "jj" },
        },
        { cwd: process.cwd() },
      ),
    ).toThrow("`hunk stash show` requires Git VCS mode.");
  });

  test("tracks untracked file changes when diff compares the working tree against one ref", () => {
    const dir = createTempRepo("hunk-watch-ref-untracked-");

    writeFileSync(join(dir, "tracked.ts"), "export const tracked = 1;\n");
    git(dir, "add", "tracked.ts");
    git(dir, "commit", "-m", "initial");
    git(dir, "branch", "main");

    writeFileSync(join(dir, "tracked.ts"), "export const tracked = 2;\n");
    git(dir, "add", "tracked.ts");
    git(dir, "commit", "-m", "second");

    const untrackedPath = join(dir, "note.txt");
    writeFileSync(untrackedPath, "first\n");

    const initialSignature = computeWatchSignature(createGitInput({ range: "main" }), {
      cwd: dir,
    });
    writeFileSync(untrackedPath, "second\n");
    const changedSignature = computeWatchSignature(createGitInput({ range: "main" }), {
      cwd: dir,
    });

    expect(changedSignature).not.toEqual(initialSignature);
  });
});
