import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run Git against a test-created checkout without shell expansion. */
export function runTestGit(root: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Create a temporary working tree; callers own removal after their test finishes. */
export function createTestWorkingTreeRepo({ unborn = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hunk-working-tree-test-")));
  runTestGit(root, "init", "--initial-branch=main");
  runTestGit(root, "config", "user.name", "Hunk Test");
  runTestGit(root, "config", "user.email", "test@example.test");
  runTestGit(root, "config", "commit.gpgsign", "false");
  if (!unborn) {
    writeFileSync(join(root, "alpha.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(root, "beta.txt"), "other\n");
    runTestGit(root, "add", "--", "alpha.txt", "beta.txt");
    runTestGit(root, "commit", "-m", "Initial test files");
  }
  return root;
}
