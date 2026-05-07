import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJjDiffArgs, runJjText } from "./jj";

const tempDirs: string[] = [];

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function createTempDir(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
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
  cleanupTempDirs();
});

describe("jj command helpers", () => {
  test("reports a friendly error when jj is not installed or not on PATH", () => {
    expect(() =>
      runJjText({
        input: {
          kind: "vcs",
          staged: false,
          options: { mode: "auto", vcs: "jj" },
        },
        args: ["root"],
        jjExecutable: "definitely-not-a-real-jj-binary",
      }),
    ).toThrow(
      'Jujutsu is required for `hunk diff` when `vcs = "jj"`, but `definitely-not-a-real-jj-binary` was not found in PATH.',
    );
  });

  test("reports a friendly error outside a jj repository", () => {
    const dir = createTempDir("hunk-jj-nonrepo-");

    expect(() =>
      runJjText({
        input: {
          kind: "vcs",
          staged: false,
          options: { mode: "auto", vcs: "jj" },
        },
        args: ["root"],
        cwd: dir,
      }),
    ).toThrow('`hunk diff` must be run inside a Jujutsu repository when `vcs = "jj"`.');
  });

  test("reports a friendly error for invalid revsets", () => {
    const dir = createTempJjRepo("hunk-jj-invalid-revset-");
    const input = {
      kind: "vcs" as const,
      range: "missing_revision",
      staged: false,
      options: { mode: "auto" as const, vcs: "jj" as const },
    };

    expect(() =>
      runJjText({
        input,
        args: buildJjDiffArgs(input),
        cwd: dir,
      }),
    ).toThrow("`hunk diff missing_revision` could not resolve Jujutsu revset `missing_revision`.");
  });
});
