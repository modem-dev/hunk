import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { verifyWorkspaceWriteTarget } from "./workspaceWriteGuard";

/**
 * The syscall half of the write policy, against real directories and real
 * links: the lexical policy in `extensionWorkspace.test.ts` cannot see any of
 * this, which is the reason this module exists.
 */

// Creating symlinks needs Developer Mode or elevation on Windows; the guard
// itself is portable, only these fixtures are not.
const describeLinks = process.platform === "win32" ? describe.skip : describe;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One throwaway directory, cleaned up after the test that made it. */
function createTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Verify one reviewed path inside `root`, the way `writeDocument` does. */
function verifyTestTarget(root: string, path: string) {
  return verifyWorkspaceWriteTarget({ absolutePath: join(root, path), path, root });
}

describe("workspace write target verification", () => {
  test("passes an ordinary reviewed file inside the root", async () => {
    const root = createTempDir("hunk-guard-file-");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "alpha.ts"), "one\n");

    await expect(verifyTestTarget(root, join("src", "alpha.ts"))).resolves.toBeNull();
  });

  test("refuses a target that has left the working tree", async () => {
    const root = createTempDir("hunk-guard-missing-");

    // A reviewed file is a file the review loaded from disk, so a missing one
    // was deleted afterwards; writing it back would undo that deletion.
    await expect(verifyTestTarget(root, "gone.ts")).resolves.toContain(
      "no longer in the working tree",
    );
  });

  test("refuses a target that is not a regular file", async () => {
    const root = createTempDir("hunk-guard-directory-");
    mkdirSync(join(root, "src"));

    await expect(verifyTestTarget(root, "src")).resolves.toContain("not a regular file");
  });
});

describeLinks("workspace write target verification against links", () => {
  test("refuses a reviewed path that is itself a symlink", async () => {
    const root = createTempDir("hunk-guard-link-");
    const outside = createTempDir("hunk-guard-link-outside-");
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret\n");
    // Git tracks a symlink to a file as an ordinary reviewable entry, so this
    // is a path a review can genuinely hand the policy.
    symlinkSync(secret, join(root, "linked.txt"));

    await expect(verifyTestTarget(root, "linked.txt")).resolves.toContain("is a symlink");
  });

  test("refuses a link that stays inside the root, without following it", async () => {
    const root = createTempDir("hunk-guard-link-inside-");
    writeFileSync(join(root, "real.txt"), "one\n");
    symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));

    // Confinement is not the only reason to refuse: the prompt names one path
    // and the write would replace a different file's contents.
    await expect(verifyTestTarget(root, "alias.txt")).resolves.toContain("is a symlink");
  });

  test("refuses a regular file under a directory link leading out of the root", async () => {
    const root = createTempDir("hunk-guard-dirlink-");
    const outside = createTempDir("hunk-guard-dirlink-outside-");
    writeFileSync(join(outside, "escaped.ts"), "one\n");
    symlinkSync(outside, join(root, "vendor"), "dir");

    // The target itself is an ordinary file and the path is lexically inside
    // the root; only resolving the parent shows where the write would land.
    await expect(verifyTestTarget(root, join("vendor", "escaped.ts"))).resolves.toContain(
      "outside the reviewed repository once links resolve",
    );
  });

  test("passes a file under a directory link that stays inside the root", async () => {
    const root = createTempDir("hunk-guard-dirlink-inside-");
    mkdirSync(join(root, "packages"));
    writeFileSync(join(root, "packages", "alpha.ts"), "one\n");
    symlinkSync(join(root, "packages"), join(root, "linked"), "dir");

    await expect(verifyTestTarget(root, join("linked", "alpha.ts"))).resolves.toBeNull();
  });

  test("passes a review root that is itself reached through a link", async () => {
    // `/tmp` is a link to `/private/tmp` on macOS, so both sides must resolve
    // or every temp-dir review would look like an escape.
    const real = createTempDir("hunk-guard-linked-root-");
    const link = join(createTempDir("hunk-guard-linked-root-parent-"), "root");
    symlinkSync(real, link, "dir");
    writeFileSync(join(real, "alpha.ts"), "one\n");

    await expect(verifyTestTarget(link, "alpha.ts")).resolves.toBeNull();
  });
});
