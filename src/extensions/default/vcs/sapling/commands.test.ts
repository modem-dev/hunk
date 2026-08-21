import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSlDiffArgs, runSlText } from "./commands";
import type { ExtensionVcsDiffInput as VcsDiffCommandInput } from "hunkdiff/extension";

const slAvailable = (() => {
  try {
    return (
      Bun.spawnSync(["sl", "version"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
        .exitCode === 0
    );
  } catch {
    return false;
  }
})();
const tempDirs: string[] = [];

function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Build one working-tree review input for the sl command helpers. */
function diffInput(overrides: Partial<VcsDiffCommandInput> = {}): VcsDiffCommandInput {
  return { kind: "vcs", staged: false, options: {}, ...overrides };
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
  test("compares two named revisions with a -r per endpoint rather than a `..` revset", () => {
    expect(buildSlDiffArgs(diffInput({ rangeEndpoints: { from: "main", to: "feature" } }))).toEqual(
      ["diff", "--git", "-r", "main", "-r", "feature"],
    );
  });

  test("passes a revset the user spelled straight through to -r", () => {
    expect(buildSlDiffArgs(diffInput({ range: ".^::." }))).toEqual([
      "diff",
      "--git",
      "-r",
      ".^::.",
    ]);
  });

  test("reports a friendly error when sl is not installed or not on PATH", () => {
    expect(() =>
      runSlText({
        input: diffInput(),
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
        input: diffInput(),
        args: ["root"],
        cwd: dir,
      }),
    ).toThrow('`hunk diff` must be run inside a Sapling repository when `vcs = "sl"`.');
  });

  test.skipIf(!slAvailable)("reports a friendly error for invalid revsets", () => {
    const dir = createTempSlRepo("hunk-sl-invalid-revset-");
    const input = diffInput({ range: "missing_revision" });

    expect(() =>
      runSlText({
        input,
        args: buildSlDiffArgs(input),
        cwd: dir,
      }),
    ).toThrow("`hunk diff missing_revision` could not resolve Sapling revset `missing_revision`.");
  });
});
