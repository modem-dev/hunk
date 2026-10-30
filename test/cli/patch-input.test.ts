import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entrypoint = resolve("packages/hunk/src/main.tsx");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Spawn the real CLI without a terminal so validation must precede renderer takeover. */
function runTestPatch(args: readonly string[], input = "") {
  return Bun.spawnSync([process.execPath, "run", entrypoint, "patch", ...args, "--no-extensions"], {
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    // Bound exit regressions at the process level; a synchronous spawn blocks test timers.
    timeout: 10_000,
    killSignal: "SIGKILL",
    env: { ...process.env, HUNK_DISABLE_UPDATE_NOTICE: "1" },
  });
}

describe("patch input CLI contract", () => {
  test.each([{ args: [] }, { args: ["-"] }])(
    "rejects arbitrary nonempty stdin (%j)",
    ({ args }) => {
      const result = runTestPatch(args, "not a patch\n");
      expect(result.exitCode).toBe(1);
      expect(Buffer.from(result.stderr).toString()).toContain(
        "No recognizable file changes in patch input (stdin patch)",
      );
      expect(Buffer.from(result.stderr).toString()).toContain(
        "check the command producing the patch",
      );
      expect(Buffer.from(result.stdout).toString()).not.toContain("\u001b[?1049h");
    },
  );

  test("rejects arbitrary nonempty patch files", () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-invalid-patch-test-"));
    tempDirs.push(dir);
    const file = join(dir, "invalid.patch");
    writeFileSync(file, "not a patch\n");
    const result = runTestPatch([file]);
    expect(result.exitCode).toBe(1);
    expect(Buffer.from(result.stderr).toString()).toContain(
      "No recognizable file changes in patch input",
    );
    expect(Buffer.from(result.stderr).toString()).toContain("invalid.patch");
  });

  test("accepts empty stdin", () => {
    const result = runTestPatch([], "");
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stderr).toString()).toBe("");
  });

  test("accepts a mail-enveloped textual patch", () => {
    const result = runTestPatch(
      [],
      "From 0123456789 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] Update\n\ndiff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n",
    );
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stderr).toString()).toBe("");
    expect(Buffer.from(result.stdout).toString()).toContain("after");
  });
});
