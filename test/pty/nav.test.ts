import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness, pressKeyRepeat } from "./harness";

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
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("Maximum update depth exceeded");

      const alphaNote = await harness.pressAndWaitForSnapshot(
        session,
        "}",
        (text) => text.includes("Alpha note for navigation."),
        5_000,
      );
      expect(alphaNote).toContain("Alpha note for navigation.");
      expect(alphaNote).not.toContain("Maximum update depth exceeded");

      await harness.pressAndWaitForSnapshot(
        session,
        ".",
        (text) => text.includes("line101 = 10100"),
        5_000,
      );

      const gammaNote = await harness.pressAndWaitForSnapshot(
        session,
        "}",
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
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 104,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line1 = 100");
      expect(initial).not.toContain("line60 = 6000");

      const secondHunk = await harness.pressAndWaitForSnapshot(
        session,
        "]",
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
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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
      const backward = await harness.pressAndWaitForSnapshot(
        session,
        "[",
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
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 104,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line1 = 100");
      expect(initial).not.toContain("line60 = 6000");

      const secondHunk = await harness.pressAndWaitForSnapshot(
        session,
        "]",
        (text) => text.includes("line60 = 6000") && !text.includes("line1 = 100"),
        5_000,
      );

      expect(secondHunk).toContain("line60 = 6000");
      expect(secondHunk).not.toContain("line1 = 100");

      const firstHunk = await harness.pressAndWaitForSnapshot(
        session,
        "[",
        (text) => text.includes("line1 = 100") && !text.includes("line60 = 6000"),
        5_000,
      );

      expect(firstHunk).toContain("line1 = 100");
      expect(firstHunk).not.toContain("line60 = 6000");
    } finally {
      session.close();
    }
  });

  test("file navigation reveals a destination hidden by a collapsed tree folder", async () => {
    const fixture = harness.createNestedSidebarRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/⌄ src\//, { timeout: 15_000 });
      const initialAlphaCount = harness.countMatches(initial, /alpha\.ts/g);
      const initialBetaCount = harness.countMatches(initial, /beta\.ts/g);
      expect(initialAlphaCount).toBeGreaterThanOrEqual(2);
      expect(initialBetaCount).toBeGreaterThanOrEqual(2);

      await session.click(/⌄ src\//);
      const collapsed = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("› src/") &&
          harness.countMatches(text, /alpha\.ts/g) === initialAlphaCount - 1 &&
          harness.countMatches(text, /beta\.ts/g) === initialBetaCount - 1,
        5_000,
      );
      expect(collapsed).toContain("› src/");
      expect(collapsed).toContain("2 files");

      const expanded = await harness.pressAndWaitForSnapshot(
        session,
        ".",
        (text) =>
          text.includes("⌄ src/") &&
          harness.countMatches(text, /alpha\.ts/g) === initialAlphaCount &&
          harness.countMatches(text, /beta\.ts/g) === initialBetaCount,
        5_000,
      );
      expect(expanded).toContain("⌄ src/");
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
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("alphaOnly = true");
      expect(initial).toContain("betaValue = 2");
      expect(initial).not.toContain("deltaOnly = true");

      await session.click(/M delta\.ts\s+\+2 -1/);
      const jumped = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("deltaOnly = true") &&
          !text.includes("alphaOnly = true") &&
          harness.countMatches(text, /epsilon\.ts/g) >= 2,
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

  test("file navigation lands on a binary file between text files", async () => {
    const fixture = harness.createBinaryNavigationRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 160,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("Binary file skipped");

      const binary = await harness.pressAndWaitForSnapshot(
        session,
        ".",
        (text) => text.includes("Binary file skipped"),
        5_000,
      );
      expect(binary).toContain("Binary file skipped");

      const zeta = await harness.pressAndWaitForSnapshot(
        session,
        ".",
        (text) => text.includes("zeta0 = 2") && !text.includes("Binary file skipped"),
        5_000,
      );
      expect(zeta).toContain("zeta0 = 2");
    } finally {
      session.close();
    }
  });

  test("clicking a binary file in the sidebar selects it", async () => {
    const fixture = harness.createBinaryNavigationRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 160,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("Binary file skipped");

      await session.click(/logo\.png/);
      const selected = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Binary file skipped"),
        5_000,
      );
      expect(selected).toContain("Binary file skipped");
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
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("first.ts");
      expect(initial).toContain("second.ts");

      await pressKeyRepeat(session, "down", 16);

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

  test("change-block keys step between edits that share one hunk", async () => {
    const fixture = harness.createSpreadHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "unified"],
      cols: 100,
      rows: 9,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("line27 = 2700");

      await session.press(")");
      const secondEdit = await harness.pressAndWaitForSnapshot(
        session,
        ")",
        (text) => text.includes("line27 = 2700"),
        5_000,
      );
      expect(secondEdit).toContain("line27 = 2700");
      expect(secondEdit).not.toContain("line17 = 17");

      const firstEdit = await harness.pressAndWaitForSnapshot(
        session,
        "(",
        (text) => text.includes("line20 = 20;") && !text.includes("line27 = 2700"),
        5_000,
      );
      expect(firstEdit).toContain("line20 = 20;");
    } finally {
      session.close();
    }
  });

  test("change-block keys step between edits with the current-line marker off", async () => {
    const fixture = harness.createSpreadHunkFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--files",
        fixture.before,
        fixture.after,
        "--mode",
        "unified",
        "--cursor-line",
        "off",
      ],
      cols: 100,
      rows: 9,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      await session.press(")");
      const secondEdit = await harness.pressAndWaitForSnapshot(
        session,
        ")",
        (text) => text.includes("line27 = 2700"),
        5_000,
      );
      expect(secondEdit).toContain("line27 = 2700");

      const firstEdit = await harness.pressAndWaitForSnapshot(
        session,
        "(",
        (text) => text.includes("line20 = 20;") && !text.includes("line27 = 2700"),
        5_000,
      );
      expect(firstEdit).toContain("line20 = 20;");
    } finally {
      session.close();
    }
  });

  test("the Navigate menu steps change blocks like their keys", async () => {
    const fixture = harness.createSpreadHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "unified"],
      cols: 120,
      rows: 32,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      for (let step = 0; step < 2; step += 1) {
        await harness.clickAndWaitForText(session, /Navigate/, /Next change/, {
          first: true,
          timeout: 5_000,
        });
        await session.click(/Next change/);
        await harness.waitForSnapshot(session, (text) => !text.includes("Next change"), 5_000);
      }

      const draft = await harness.pressAndWaitForText(
        session,
        "c",
        /Draft note - before\.ts -> after\.ts [LR]27/,
        { timeout: 5_000 },
      );
      expect(draft).toMatch(/Draft note - before\.ts -> after\.ts [LR]27/);
    } finally {
      session.close();
    }
  });

  test("thread keys visit each note that shares one hunk", async () => {
    const fixture = harness.createSpreadHunkAgentFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--files",
        fixture.before,
        fixture.after,
        "--mode",
        "unified",
        "--agent-context",
        fixture.agentContext,
        "--agent-notes",
      ],
      cols: 100,
      rows: 12,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      const firstNote = await harness.pressAndWaitForSnapshot(
        session,
        ">",
        (text) => text.includes("FIRST SPREAD NOTE"),
        5_000,
      );
      expect(firstNote).toContain("FIRST SPREAD NOTE");

      const secondNote = await harness.pressAndWaitForSnapshot(
        session,
        ">",
        (text) => text.includes("SECOND SPREAD NOTE") && !text.includes("FIRST SPREAD NOTE"),
        5_000,
      );
      expect(secondNote).toContain("SECOND SPREAD NOTE");

      const backToFirst = await harness.pressAndWaitForSnapshot(
        session,
        "<",
        (text) => text.includes("FIRST SPREAD NOTE"),
        5_000,
      );
      expect(backToFirst).toContain("FIRST SPREAD NOTE");
    } finally {
      session.close();
    }
  });
});
