import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give source and compiled PTY startup enough headroom while keeping refresh waits event-bounded. */
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY watch mode", () => {
  test("passively refreshes direct files after an atomic save", async () => {
    const fixture = harness.createWatchFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--watch", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 120,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/watchedValue = 'initial change'/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("atomic replacement");

      const replacement = join(dirname(fixture.after), "after-replacement.ts");
      writeFileSync(replacement, "export const watchedValue = 'atomic replacement';\n");
      renameSync(replacement, fixture.after);

      const refreshed = await session.waitForText(/watchedValue = 'atomic replacement'/, {
        timeout: 5_000,
      });
      expect(refreshed).not.toContain("watchedValue = 'initial change'");
    } finally {
      session.close();
    }
  });

  test("passively refreshes a tracked file in a linked Git worktree", async () => {
    const fixture = harness.createLinkedWorktreeWatchFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--watch", "--mode", "stack"],
      cwd: fixture.worktreeDir,
      cols: 120,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/linkedValue = 'initial change'/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("passive worktree refresh");

      writeFileSync(
        fixture.trackedFile,
        "export const linkedValue = 'passive worktree refresh';\n",
      );

      const refreshed = await session.waitForText(/linkedValue = 'passive worktree refresh'/, {
        timeout: 5_000,
      });
      expect(refreshed).not.toContain("linkedValue = 'initial change'");
    } finally {
      session.close();
    }
  });
});
