import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSlDiffArgs, runSlText } from "./sl";

const slAvailable =
  Bun.spawnSync(["sl", "version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    .exitCode === 0;
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
  cleanupTempDirs();
});

describe("sl command helpers", () => {
  test("reports a friendly error when sl is not installed or not on PATH", () => {
    expect(() =>
      runSlText({
        input: {
          kind: "vcs",
          staged: false,
          options: { mode: "auto", vcs: "sl" },
        },
        args: ["root"],
        slExecutable: "definitely-not-a-real-sl-binary",
      }),
    ).toThrow(
      'Sapling is required for `hunk diff` when `vcs = "sl"`, but `definitely-not-a-real-sl-binary` was not found in PATH.',
    );
  });

  test.skipIf(!slAvailable)("reports a friendly error outside a sl repository", () => {
    const dir = createTempDir("hunk-sl-nonrepo-");

    expect(() =>
      runSlText({
        input: {
          kind: "vcs",
          staged: false,
          options: { mode: "auto", vcs: "sl" },
        },
        args: ["root"],
        cwd: dir,
      }),
    ).toThrow('`hunk diff` must be run inside a Sapling repository when `vcs = "sl"`.');
  });

  test.skipIf(!slAvailable)("reports a friendly error for invalid revsets", () => {
    const dir = createTempSlRepo("hunk-sl-invalid-revset-");
    const input = {
      kind: "vcs" as const,
      range: "missing_revision",
      staged: false,
      options: { mode: "auto" as const, vcs: "sl" as const },
    };

    expect(() =>
      runSlText({
        input,
        args: buildSlDiffArgs(input),
        cwd: dir,
      }),
    ).toThrow("`hunk diff missing_revision` could not resolve Sapling revset `missing_revision`.");
  });
});
