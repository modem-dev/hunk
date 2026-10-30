import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

/** Restore a disposable harness repository to its committed, clean state. */
function createTestCleanRepoFixture() {
  const fixture = harness.createSidebarJumpRepoFixture();
  const reset = Bun.spawnSync(["git", "reset", "--hard", "HEAD"], {
    cwd: fixture.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(reset.exitCode).toBe(0);
  return fixture;
}

describe("empty review messages (PTY)", () => {
  test("a clean working tree reports no changes without suggesting an active filter", async () => {
    const fixture = createTestCleanRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--no-extensions"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      const frame = await session.waitForText(/No changes to review\./);
      expect(frame).not.toContain("No files match");
      session.resize({ cols: 60, rows: 12 });
      await harness.waitForSnapshot(session, (text) => text.includes("No changes to review."));
    } finally {
      session.close();
    }
  });

  test("empty patch stdin reports no changes without suggesting an active filter", async () => {
    const fixture = createTestCleanRepoFixture();
    const stdinFile = join(fixture.dir, "empty.patch");
    writeFileSync(stdinFile, "");
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile,
      args: ["patch", "--no-extensions"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      const frame = await session.waitForText(/No changes to review\./);
      expect(frame).not.toContain("No files match");
    } finally {
      session.close();
    }
  });

  test("a filter hiding an existing review still reports no matching files", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--no-extensions"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/alphaOnly = true/);
      await session.press("tab");
      await session.waitForText(/filter: type to filter files/);
      await session.type("no-such-file");
      const filtered = await session.waitForText(/No files match the current filter\./);
      expect(filtered).not.toContain("No changes to review.");
      await session.press("escape");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("alphaOnly = true") && !text.includes("No files match"),
      );
    } finally {
      session.close();
    }
  });
});
