import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY navigation", () => {
  test("comment navigation resumes from an unannotated hunk in stream order", async () => {
    const fixture = harness.createAgentNavigationRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split", "--agent-context", fixture.agentContext, "--agent-notes"],
      cwd: fixture.dir,
      cols: 160,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("Maximum update depth exceeded");

      await session.press("}");
      const alphaNote = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Alpha note for navigation."),
        5_000,
      );
      expect(alphaNote).toContain("Alpha note for navigation.");
      expect(alphaNote).not.toContain("Maximum update depth exceeded");

      await session.press(".");
      await harness.waitForSnapshot(session, (text) => text.includes("line101 = 10100"), 5_000);

      await session.press("}");
      const gammaNote = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Gamma note for navigation."),
        5_000,
      );

      expect(gammaNote).toContain("Gamma note for navigation.");
      expect(gammaNote).not.toContain("Alpha note for navigation.");
      expect(gammaNote).not.toContain("Maximum update depth exceeded");
    } finally {
      session.close();
    }
  });

  test("real hunk navigation jumps to later hunks in the review stream", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 104,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line1 = 100");
      expect(initial).not.toContain("line60 = 6000");

      await session.press("]");
      const secondHunk = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line60 = 6000"),
        5_000,
      );

      expect(secondHunk).toContain("line60 = 6000");
      expect(secondHunk).not.toContain("line1 = 100");
    } finally {
      session.close();
    }
  });

  test("backward cross-file hunk navigation reveals the target hunk in a real PTY", async () => {
    const fixture = harness.createCrossFileHunkNavigationRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 120,
      rows: 16,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      let reachedShortFileMidHunk = false;
      for (let index = 0; index < 24; index += 1) {
        await session.press("]");
        const snapshot = await session.text({ immediate: true });
        if (snapshot.includes("export const mid = 4;")) {
          reachedShortFileMidHunk = true;
          break;
        }
      }

      if (!reachedShortFileMidHunk) {
        await harness.waitForSnapshot(
          session,
          (text) => text.includes("export const mid = 4;"),
          5_000,
        );
      }

      await session.press("[");
      await session.waitIdle({ timeout: 80 });
      await session.press("[");
      const backward = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line 341 changed") || text.includes("line 002 changed"),
        5_000,
      );

      expect(backward).toContain("line 341 changed");
      expect(backward).not.toContain("line 002 changed");
    } finally {
      session.close();
    }
  });

  test("PTY sessions can navigate forward and backward between distant hunks in one large file", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 104,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line1 = 100");
      expect(initial).not.toContain("line60 = 6000");

      await session.press("]");
      const secondHunk = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line60 = 6000") && !text.includes("line1 = 100"),
        5_000,
      );

      expect(secondHunk).toContain("line60 = 6000");
      expect(secondHunk).not.toContain("line1 = 100");

      await session.press("[");
      const firstHunk = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line1 = 100") && !text.includes("line60 = 6000"),
        5_000,
      );

      expect(firstHunk).toContain("line1 = 100");
      expect(firstHunk).not.toContain("line60 = 6000");
    } finally {
      session.close();
    }
  });

  test("sidebar selection jumps the main pane without collapsing the review stream", async () => {
    const fixture = harness.createSidebarJumpRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("alphaOnly = true");
      expect(initial).toContain("betaValue = 2");
      expect(initial).not.toContain("deltaOnly = true");

      await session.click(/M delta\.ts\s+\+2 -1/);
      const jumped = await harness.waitForSnapshot(
        session,
        (text) => text.includes("deltaOnly = true") && !text.includes("alphaOnly = true"),
        5_000,
      );

      expect(jumped).toContain("deltaValue = 2");
      expect(jumped).toContain("deltaOnly = true");
      expect(jumped).not.toContain("alphaOnly = true");
      expect(harness.countMatches(jumped, /epsilon\.ts/g)).toBeGreaterThanOrEqual(2);
    } finally {
      session.close();
    }
  });

  test("clicking a sidebar file pins that file header to the top in a real PTY", async () => {
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 10,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("first.ts");
      expect(initial).toContain("second.ts");

      for (let index = 0; index < 8; index += 1) {
        await session.press("down");
      }

      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line08 = 108") && text.includes("first.ts"),
        5_000,
      );

      expect(scrolled).toContain("first.ts");

      await session.click(/M second\.ts\s+\+16 -16/);
      const pinned = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("second.ts") &&
          text.includes("line17 = 117") &&
          harness.countMatches(text, /first\.ts/g) === 1,
        5_000,
      );

      expect(pinned).toContain("second.ts");
      expect(pinned).toContain("line17 = 117");
      expect(harness.countMatches(pinned, /first\.ts/g)).toBe(1);
    } finally {
      session.close();
    }
  });
});
