import { afterEach, describe, expect, test } from "bun:test";
import { fetchPullRequestPatch, GitHubCliError } from "./github";

const originalSpawn = Bun.spawn;
const mutableBun = Bun as unknown as { spawn: typeof Bun.spawn };

afterEach(() => {
  mutableBun.spawn = originalSpawn;
});

/**
 * Replace Bun.spawn with a fake that emits controlled stdout/stderr/exit via a
 * real Node subprocess, recording the argv the code under test requested.
 */
function stubSpawn(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  throwOnSpawn?: boolean;
}): { calls: string[][] } {
  const calls: string[][] = [];
  const { stdout = "", stderr = "", exitCode = 0, throwOnSpawn = false } = options;

  mutableBun.spawn = ((command: string[]) => {
    calls.push(command);
    if (throwOnSpawn) {
      throw new Error("spawn ENOENT");
    }

    const script =
      `process.stdout.write(${JSON.stringify(stdout)});` +
      `process.stderr.write(${JSON.stringify(stderr)});` +
      `process.exit(${exitCode});`;

    return originalSpawn([process.execPath, "--eval", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  }) as typeof Bun.spawn;

  return { calls };
}

const SAMPLE_PATCH = `diff --git a/a.txt b/a.txt
index 0000000..1111111 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
+new
`;

describe("fetchPullRequestPatch", () => {
  test("returns the patch text and a numbered label", async () => {
    const { calls } = stubSpawn({ stdout: SAMPLE_PATCH });

    const result = await fetchPullRequestPatch("68");

    expect(result.text).toBe(SAMPLE_PATCH);
    expect(result.label).toBe("PR #68");
    expect(calls[0]).toEqual(["gh", "pr", "diff", "68", "--patch"]);
  });

  test("passes --repo through to gh when provided", async () => {
    const { calls } = stubSpawn({ stdout: SAMPLE_PATCH });

    await fetchPullRequestPatch("68", "modem-dev/hunk");

    expect(calls[0]).toEqual(["gh", "pr", "diff", "68", "--patch", "--repo", "modem-dev/hunk"]);
  });

  test("labels non-numeric refs without a hash", async () => {
    stubSpawn({ stdout: SAMPLE_PATCH });

    const result = await fetchPullRequestPatch("https://github.com/modem-dev/hunk/pull/68");

    expect(result.label).toBe("PR https://github.com/modem-dev/hunk/pull/68");
  });

  test("throws a friendly error when gh is not installed", async () => {
    stubSpawn({ throwOnSpawn: true });

    await expect(fetchPullRequestPatch("68")).rejects.toBeInstanceOf(GitHubCliError);
    await expect(fetchPullRequestPatch("68")).rejects.toThrow(/GitHub CLI \(gh\)/);
  });

  test("surfaces gh stderr on a non-zero exit", async () => {
    stubSpawn({ stderr: "no pull requests found for branch", exitCode: 1 });

    await expect(fetchPullRequestPatch("999")).rejects.toThrow(
      /Failed to fetch PR #999.*no pull requests found/s,
    );
  });

  test("rejects an empty diff", async () => {
    stubSpawn({ stdout: "\n" });

    await expect(fetchPullRequestPatch("68")).rejects.toThrow(/no diff to review/);
  });
});
