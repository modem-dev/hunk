import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Session } from "tuistory";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send an SGR mouse motion event at zero-based terminal coordinates. */
async function moveMouse(session: Session, x: number, y: number) {
  session.writeRaw(`\x1b[<35;${x + 1};${y + 1}M`);
  await session.waitIdle();
}

/** Drag with the left mouse button using zero-based terminal coordinates. */
async function dragMouse(
  session: Session,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) {
  session.writeRaw(`\x1b[<0;${startX + 1};${startY + 1}M`);
  await sleep(10);
  const steps = 5;
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(startX + ((endX - startX) * step) / steps);
    const y = Math.round(startY + ((endY - startY) * step) / steps);
    session.writeRaw(`\x1b[<32;${x + 1};${y + 1}M`);
    await sleep(10);
  }
  session.writeRaw(`\x1b[<0;${endX + 1};${endY + 1}m`);
  await session.waitIdle();
}

/** Find the rightmost visible column for text in a terminal snapshot. */
function rightmostColumnOf(text: string, needle: string) {
  return Math.max(
    ...text
      .split("\n")
      .map((line) => line.lastIndexOf(needle))
      .filter((column) => column >= 0),
    -1,
  );
}

/** Locate a visible terminal row containing text so mouse tests can target rendered content. */
function lineIndexOf(text: string, needle: string) {
  return text.split("\n").findIndex((line) => line.includes(needle));
}

/** Move near a rendered row until the hover-only add-note control appears. */
async function revealAddNoteNear(session: Session, row: number) {
  for (const y of [row, row - 1, row + 1]) {
    if (y < 0) {
      continue;
    }

    for (const x of [8, 20, 60]) {
      await moveMouse(session, x, y);
      try {
        await session.waitForText(/\[\+\]/, { timeout: 200 });
        return;
      } catch {
        // Try nearby cells; PTY snapshots and wrapped rows can differ by a column or row.
      }
    }
  }

  throw new Error("Could not reveal add-note affordance near target row.");
}

describe("live UI integration", () => {
  test("real PTY sessions can toggle wrapped lines on and off", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 102,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("before.ts");
      expect(initial).toContain("after.ts");
      expect(initial).toContain("this is a very long");
      expect(initial).not.toContain("ge';");

      await session.press("w");
      const wrapped = await harness.waitForSnapshot(
        session,
        (text) => text.includes("ge';"),
        5_000,
      );

      expect(wrapped).toContain("ge';");

      await session.press("w");
      const unwrapped = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("ge';"),
        5_000,
      );

      expect(unwrapped).not.toContain("ge';");
    } finally {
      session.close();
    }
  });

  test("agent notes can be revealed and hidden in the live diff UI", async () => {
    const fixture = harness.createAgentFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        fixture.before,
        fixture.after,
        "--mode",
        "split",
        "--agent-context",
        fixture.agentContext,
      ],
      cols: 140,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).not.toContain("Adds bonus export.");

      await session.press("a");
      const withNotes = await session.waitForText(/Adds bonus export\./, { timeout: 5_000 });

      expect(withNotes).toContain("Highlights the follow-up addition for review.");

      await session.press("a");
      const withoutNotes = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Adds bonus export."),
        5_000,
      );

      expect(withoutNotes).not.toContain("Adds bonus export.");
    } finally {
      session.close();
    }
  });

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

  test("user notes can be drafted and saved inline in a real PTY", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 20,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await session.press("c");
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Please cover this edge case.");

      const draftBeforeNewline = await session.waitForText(/Please cover this edge case\./, {
        timeout: 5_000,
      });
      const saveRowBeforeNewline = draftBeforeNewline
        .split("\n")
        .findIndex((line) => line.includes("Save") && line.includes("Cancel"));
      expect(saveRowBeforeNewline).toBeGreaterThanOrEqual(0);

      await session.type("\x0a");
      await harness.waitForSnapshot(
        session,
        (text) => {
          const saveRowAfterNewline = text
            .split("\n")
            .findIndex((line) => line.includes("Save") && line.includes("Cancel"));
          return (
            text.includes("Please cover this edge case.") &&
            saveRowAfterNewline > saveRowBeforeNewline
          );
        },
        5_000,
      );

      await session.type("Second line.");
      await session.type("\x13");

      const savedNote = await session.waitForText(/Your note/, { timeout: 5_000 });
      expect(savedNote).toContain("Please cover this edge case.");
      expect(savedNote).toContain("Second line.");
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

      for (let index = 0; index < 19; index += 1) {
        await session.press("]");
        await session.waitIdle({ timeout: 40 });
      }

      await harness.waitForSnapshot(
        session,
        (text) => text.includes("export const mid = 4;"),
        5_000,
      );

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

  test("a short last file does not trap upward scrolling at the bottom edge", async () => {
    const fixture = harness.createBottomClampedRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 10,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await session.press("]");
      const bottomAligned = await harness.waitForSnapshot(
        session,
        (text) => text.includes("shortLine1 = 10;"),
        5_000,
      );

      expect(bottomAligned).not.toContain("line30 = 130");

      for (let iteration = 0; iteration < 4; iteration += 1) {
        await session.press("up");
        await session.waitIdle({ timeout: 200 });
      }

      const movedUp = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line30 = 130"),
        5_000,
      );

      expect(movedUp).toContain("line30 = 130");
    } finally {
      session.close();
    }
  });

  test("auto layout responds to live terminal resize in a real PTY", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "auto"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const wide = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(harness.countMatches(wide, /alpha\.ts/g)).toBeGreaterThanOrEqual(2);
      expect(wide).toMatch(/▌.*▌/);

      session.resize({ cols: 150, rows: 24 });
      const tight = await harness.waitForSnapshot(session, (text) => !/▌.*▌/.test(text), 5_000);

      expect(harness.countMatches(tight, /alpha\.ts/g)).toBeLessThan(
        harness.countMatches(wide, /alpha\.ts/g),
      );
      expect(tight).not.toMatch(/▌.*▌/);
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

  test("dragging the sidebar divider resizes the review pane in a real PTY", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 18,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      const initialMainColumn = rightmostColumnOf(initial, "alpha.ts");

      expect(initialMainColumn).toBeGreaterThan(34);

      await dragMouse(session, 34, 6, 54, 6);
      const resized = await harness.waitForSnapshot(
        session,
        (text) => rightmostColumnOf(text, "alpha.ts") >= initialMainColumn + 3,
        5_000,
      );

      expect(rightmostColumnOf(resized, "alpha.ts")).toBeGreaterThan(initialMainColumn);
      expect(resized).toContain("beta.ts");
    } finally {
      session.close();
    }
  });

  test("clicking and dragging the live scrollbar scrolls the review pane", async () => {
    const fixture = harness.createScrollableFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 10,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line01 = 101");
      expect(initial).not.toContain("line12 = 112");

      await session.scrollDown(5, 60, 6);
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("line08 = 108") || text.includes("line09 = 109"),
        5_000,
      );

      let scrollbarX: number | null = null;
      let trackClicked = "";
      for (const x of [119, 118, 117, 116]) {
        await session.clickAt(x, 8);
        try {
          trackClicked = await harness.waitForSnapshot(
            session,
            (text) => text.includes("line12 = 112") || text.includes("line13 = 113"),
            1_000,
          );
          scrollbarX = x;
          break;
        } catch {
          // Try the next near-edge column; PTY backends differ by one cell at pane edges.
        }
      }

      expect(scrollbarX).not.toBeNull();
      expect(trackClicked).toContain("line1");
      expect(trackClicked).not.toContain("line01 = 101");

      await dragMouse(session, scrollbarX ?? 118, 5, scrollbarX ?? 118, 8);
      const thumbDragged = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line15 = 115") || text.includes("line16 = 116"),
        5_000,
      );

      expect(thumbDragged).toContain("line1");
      expect(thumbDragged).not.toContain("line01 = 101");
    } finally {
      session.close();
    }
  });

  test("add-note affordance appears only after mouse movement in a real PTY", async () => {
    const fixture = harness.createScrollableFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 12,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await moveMouse(session, 8, 5);
      await session.waitForText(/\[\+\]/, { timeout: 5_000 });

      await session.scrollDown(2);
      const afterWheel = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("[+]"),
        5_000,
      );
      expect(afterWheel).not.toContain("[+]");

      await sleep(250);
      const afterWheelIdle = await session.text({ immediate: true });
      expect(afterWheelIdle).not.toContain("[+]");

      await moveMouse(session, 9, 5);
      await session.waitForText(/\[\+\]/, { timeout: 5_000 });

      await session.press("down");
      const afterKeyboard = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("[+]"),
        5_000,
      );
      expect(afterKeyboard).not.toContain("[+]");

      await sleep(250);
      const afterKeyboardIdle = await session.text({ immediate: true });
      expect(afterKeyboardIdle).not.toContain("[+]");
    } finally {
      session.close();
    }
  });

  test("clicked add-note drafts can cancel and save with keyboard shortcuts", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 20,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await moveMouse(session, 8, 5);
      await session.waitForText(/\[\+\]/, { timeout: 5_000 });
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Cancel this shortcut draft.");
      await session.press("escape");
      const cancelled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Draft note") && !text.includes("Cancel this shortcut draft."),
        5_000,
      );

      expect(cancelled).not.toContain("Your note");

      await moveMouse(session, 8, 5);
      await session.waitForText(/\[\+\]/, { timeout: 5_000 });
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Save this shortcut draft.");
      await session.press(["ctrl", "s"]);
      const saved = await session.waitForText(/Your note/, { timeout: 5_000 });

      expect(saved).toContain("Save this shortcut draft.");
    } finally {
      session.close();
    }
  });

  test("clicking stack-mode add-note affordances can save draft notes", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "stack"],
      cols: 100,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/this is a very long/, {
        timeout: 15_000,
      });
      const targetRow = lineIndexOf(initial, "this is a very long");
      expect(targetRow).toBeGreaterThan(0);

      await revealAddNoteNear(session, targetRow);
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Save this stack draft.");
      await session.press(["ctrl", "s"]);
      const saved = await session.waitForText(/Your note/, { timeout: 5_000 });

      expect(saved).toContain("Save this stack draft.");
    } finally {
      session.close();
    }
  });

  test("clicking deletion-only add-note affordances can save draft notes", async () => {
    const fixture = harness.createDeletionOnlyFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/removeMe/, {
        timeout: 15_000,
      });
      const targetRow = lineIndexOf(initial, "removeMe");
      expect(targetRow).toBeGreaterThan(0);

      await revealAddNoteNear(session, targetRow);
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Save this deletion draft.");
      await session.press(["ctrl", "s"]);
      const saved = await session.waitForText(/Your note/, { timeout: 5_000 });

      expect(saved).toContain("Save this deletion draft.");
    } finally {
      session.close();
    }
  });

  test("clicking diff add-note affordances can cancel and save draft notes", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 20,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await moveMouse(session, 8, 5);
      await session.waitForText(/\[\+\]/, { timeout: 5_000 });
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Cancel this draft.");
      await session.click(/Cancel \(Esc\)/);
      const cancelled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Draft note") && !text.includes("Cancel this draft."),
        5_000,
      );

      expect(cancelled).not.toContain("Your note");

      await moveMouse(session, 8, 5);
      await session.waitForText(/\[\+\]/, { timeout: 5_000 });
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Save this clicked draft.");
      await session.click(/Save \(\^S\)/);
      const saved = await session.waitForText(/Your note/, { timeout: 5_000 });

      expect(saved).toContain("Save this clicked draft.");
    } finally {
      session.close();
    }
  });

  test("top menu mouse navigation can select themes, toggle agent notes, and open help", async () => {
    const fixture = harness.createAgentFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        fixture.before,
        fixture.after,
        "--mode",
        "split",
        "--agent-context",
        fixture.agentContext,
        "--agent-notes",
      ],
      cols: 140,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/Adds bonus export\./, { timeout: 15_000 });
      expect(initial).toContain("Highlights the follow-up addition for review.");

      await session.click(/Theme/);
      const themeMenu = await session.waitForText(/Midnight/, { timeout: 5_000 });
      expect(themeMenu).toContain("Paper");

      await session.click(/Paper/);
      const themeSelected = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Adds bonus export.") && !text.includes("Midnight"),
        5_000,
      );
      expect(themeSelected).toContain("Adds bonus export.");

      await session.click(/Agent/, { first: true });
      const agentMenu = await session.waitForText(/Next annotated file/, { timeout: 5_000 });
      expect(agentMenu).toContain("Agent notes");

      await session.click(/Agent notes/);
      await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Adds bonus export.") && !text.includes("Agent notes"),
        5_000,
      );

      await session.click(/Agent/, { first: true });
      await session.waitForText(/Agent notes/, { timeout: 5_000 });
      await session.click(/Agent notes/);
      await session.waitForText(/Adds bonus export\./, { timeout: 5_000 });

      await session.click(/Help/);
      await session.waitForText(/Controls help/, { timeout: 5_000 });
      await session.click(/Controls help/);
      const helpDialog = await session.waitForText(/Navigation/, { timeout: 5_000 });

      expect(helpDialog).toContain("g / G");
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

  test("mouse wheel scrolling preserves the divider and header handoff in a real PTY", async () => {
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

      await session.scrollDown(17);
      const boundary = await harness.waitForSnapshot(
        session,
        (text) =>
          harness.countMatches(text, /first\.ts/g) === 2 &&
          harness.countMatches(text, /second\.ts/g) === 2 &&
          text.includes("@@ -1,16 +1,16 @@") &&
          text.includes("line17 = 117"),
        5_000,
      );

      expect(boundary).toContain("first.ts");
      expect(boundary).toContain("second.ts");
      expect(boundary).toContain("@@ -1,16 +1,16 @@");
      expect(boundary).toContain("line17 = 117");

      await session.scrollDown(1);
      const nextHeader = await harness.waitForSnapshot(
        session,
        (text) =>
          harness.countMatches(text, /first\.ts/g) === 2 &&
          harness.countMatches(text, /second\.ts/g) === 2 &&
          text.includes("line18 = 118"),
        5_000,
      );

      expect(nextHeader).toContain("first.ts");
      expect(nextHeader).toContain("second.ts");
      expect(nextHeader).toContain("line18 = 118");

      let handedOff: string | null = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await session.scrollDown(1);

        try {
          handedOff = await harness.waitForSnapshot(
            session,
            (text) =>
              harness.countMatches(text, /first\.ts/g) === 1 &&
              harness.countMatches(text, /second\.ts/g) === 2 &&
              !text.includes("@@ -1,16 +1,16 @@"),
            700,
          );
          break;
        } catch {
          // Real PTY wheel events can land a few rows differently across environments.
          // Keep scrolling a little farther before declaring the handoff broken.
        }
      }

      expect(handedOff).not.toBeNull();
      expect(harness.countMatches(handedOff!, /first\.ts/g)).toBe(1);
      expect(harness.countMatches(handedOff!, /second\.ts/g)).toBe(2);
      expect(handedOff!).not.toContain("@@ -1,16 +1,16 @@");
    } finally {
      session.close();
    }
  });

  test("explicit split mode stays split after a live resize", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const wide = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(harness.countMatches(wide, /alpha\.ts/g)).toBeGreaterThanOrEqual(2);
      expect(wide).toMatch(/▌.*▌/);

      session.resize({ cols: 140, rows: 24 });
      const tight = await harness.waitForSnapshot(
        session,
        (text) => /▌.*▌/.test(text) && harness.countMatches(text, /alpha\.ts/g) === 1,
        5_000,
      );

      expect(tight).toContain("betaValue = 1");
    } finally {
      session.close();
    }
  });

  test("explicit stack mode stays stacked after a live resize", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 140,
      rows: 24,
    });

    try {
      const narrow = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(harness.countMatches(narrow, /alpha\.ts/g)).toBe(1);
      expect(narrow).not.toMatch(/▌.*▌/);

      session.resize({ cols: 220, rows: 24 });
      const wide = await harness.waitForSnapshot(
        session,
        (text) => !/▌.*▌/.test(text) && harness.countMatches(text, /alpha\.ts/g) >= 2,
        5_000,
      );

      expect(wide).toContain("1   -  export const alpha = 1;");
    } finally {
      session.close();
    }
  });

  test("filter focus narrows the visible review stream in the live app", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("add = true");
      expect(initial).toContain("betaValue");

      await session.press("tab");
      await session.type("beta");
      const filtered = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("betaValue") && !text.includes("alpha.ts") && !text.includes("add = true"),
        5_000,
      );

      expect(filtered.toLowerCase()).toContain("filter");
      expect(filtered).toContain("beta");
      expect(filtered).toContain("betaValue");
      expect(filtered).not.toContain("add = true");
    } finally {
      session.close();
    }
  });

  test("slash focuses the filter and narrows the visible review stream", async () => {
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

      await session.type("/");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("filter: type to filter files"),
        5_000,
      );

      await session.type("delta");
      const filtered = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("filter: delta") &&
          text.includes("deltaOnly = true") &&
          !text.includes("alphaOnly = true"),
        5_000,
      );

      expect(filtered.toLowerCase()).toContain("filter");
      expect(filtered).toContain("delta");
      expect(filtered).toContain("deltaOnly = true");
      expect(filtered).not.toContain("alphaOnly = true");
    } finally {
      session.close();
    }
  });

  test("pager mode hides chrome and pages forward on space", async () => {
    const fixture = harness.createPagerPatchFixture();
    const session = await harness.launchHunk({
      args: ["patch", fixture.patchFile, "--pager"],
      cols: 120,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_23");

      // CI can surface the pager header before the first page is fully ready to consume keys.
      await session.waitIdle({ timeout: 200 });
      await session.press("space");
      const paged = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_23") || text.includes("after_06"),
        5_000,
      );

      expect(paged).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(paged).toContain("before_23");
    } finally {
      session.close();
    }
  });

  test("pager mode handles half-page, page-up, and content-jump keyboard navigation", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunk({
      args: ["patch", fixture.patchFile, "--pager"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.press("d");
      const halfPaged = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01"),
        5_000,
      );

      expect(halfPaged).not.toContain("before_01");

      await session.press("u");
      const halfPageRestored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01"),
        5_000,
      );

      expect(halfPageRestored).toContain("before_01");

      await session.press("space");
      const paged = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_18") || text.includes("after_02"),
        5_000,
      );

      expect(paged.includes("before_18") || paged.includes("after_02")).toBe(true);

      await session.press("b");
      const pageRestored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("after_02"),
        5_000,
      );

      expect(pageRestored).toContain("before_01");
      expect(pageRestored).not.toContain("after_02");

      await session.press("end");
      const bottom = await harness.waitForSnapshot(
        session,
        (text) => text.includes("after_60"),
        5_000,
      );

      expect(bottom).toContain("after_60");

      await session.press("home");
      const top = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("after_60"),
        5_000,
      );

      expect(top).toContain("before_01");
      expect(top).not.toContain("after_60");
    } finally {
      session.close();
    }
  });

  test("piped stdin still allows concrete-theme app startup to read terminal input", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchShellCommand({
      command: `printf ignored | ${harness.buildHunkCommand(["diff", "--theme", "graphite"])}`,
      cwd: fixture.dir,
      cols: 120,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(initial).toContain("alpha.ts");

      await session.press("q");
      await session.waitIdle({ timeout: 500 });
    } finally {
      session.close();
    }
  });

  test("stdin patch mode enables mouse wheel scrolling in pager UI", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["patch", "-"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      await session.scrollDown(10);
      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01") && text.includes("before_12"),
        5_000,
      );

      expect(scrolled).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      await session.scrollUp(10);
      const restored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("before_12"),
        5_000,
      );

      expect(restored).toContain("before_01");
      expect(restored).not.toContain("before_12");
    } finally {
      session.close();
    }
  });

  test("stdin patch auto theme still enables mouse wheel scrolling", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["patch", "-", "--theme", "auto"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      await session.scrollDown(10);
      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01") && text.includes("before_12"),
        5_000,
      );

      expect(scrolled).toContain("before_12");
    } finally {
      session.close();
    }
  });

  test("general pager mode enables mouse wheel scrolling for diff-like stdin", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["pager"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      await session.scrollDown(10);
      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01") && text.includes("before_12"),
        5_000,
      );

      expect(scrolled).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      await session.scrollUp(10);
      const restored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("before_12"),
        5_000,
      );

      expect(restored).toContain("before_01");
      expect(restored).not.toContain("before_12");
    } finally {
      session.close();
    }
  });

  test("general pager mode can display the sidebar file tree", async () => {
    const fixture = harness.createPagerPatchFixture();
    const session = await harness.launchHunkWithFileBackedStdin({
      stdinFile: fixture.patchFile,
      args: ["pager"],
      cols: 120,
      rows: 14,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(harness.countMatches(initial, /scroll\.ts/g)).toBe(1);

      await session.press("s");
      const sidebarRow = /\bM scroll\.ts\s+\+40 -40/;
      const withSidebar = await harness.waitForSnapshot(
        session,
        (text) => sidebarRow.test(text),
        5_000,
      );

      expect(withSidebar).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(withSidebar).toMatch(sidebarRow);
    } finally {
      session.close();
    }
  });

  test("explicit pager mode still supports mouse wheel scrolling on a TTY", async () => {
    const fixture = harness.createPagerPatchFixture(60);
    const session = await harness.launchHunk({
      args: ["patch", fixture.patchFile, "--pager"],
      cols: 120,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/scroll\.ts/, { timeout: 15_000 });

      expect(initial).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(initial).toContain("before_01");
      expect(initial).not.toContain("before_12");

      await session.waitIdle({ timeout: 200 });
      await session.scrollDown(10);
      const scrolled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("before_01") && text.includes("before_12"),
        5_000,
      );

      expect(scrolled).not.toContain("View  Navigate  Theme  Agent  Help");
      expect(scrolled).not.toContain("before_01");
      expect(scrolled).toContain("before_12");

      await session.scrollUp(10);
      const restored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("before_01") && !text.includes("before_12"),
        5_000,
      );

      expect(restored).toContain("before_01");
      expect(restored).not.toContain("before_12");
    } finally {
      session.close();
    }
  });

  test("keyboard help can open with ? in a real PTY", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await session.press("?");
      const help = await harness.waitForSnapshot(
        session,
        (text) =>
          (text.includes("Keyboard help") || text.includes("Controls help")) &&
          text.includes("move line-by-line"),
        5_000,
      );

      expect(help.includes("Keyboard help") || help.includes("Controls help")).toBe(true);
      expect(help).toContain("move line-by-line");
    } finally {
      session.close();
    }
  });

  test("mouse menu navigation can switch the diff layout", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toMatch(/▌.*▌/);

      await session.click(/View/);
      const menu = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Stacked view") && text.includes("Split view"),
        5_000,
      );

      expect(menu).toContain("Stacked view");
      expect(menu).toContain("Split view");

      await session.click(/Stacked view/);
      const stacked = await harness.waitForSnapshot(
        session,
        (text) => !/▌.*▌/.test(text) && text.includes("1   -  export const alpha = 1;"),
        5_000,
      );

      expect(stacked).not.toMatch(/▌.*▌/);
      expect(stacked).toContain("1   -  export const alpha = 1;");
      expect(stacked).toContain("1   -  export const beta = 1;");
    } finally {
      session.close();
    }
  });

  test("keyboard menu navigation can switch layouts in a real PTY", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toMatch(/▌.*▌/);

      await session.press("f10");
      const fileMenu = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Toggle files/filter focus") && text.includes("Quit"),
        5_000,
      );

      expect(fileMenu).toContain("Reload");

      await session.press("right");
      const viewMenu = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Split view") && text.includes("Stacked view"),
        5_000,
      );

      expect(viewMenu).toContain("Auto layout");

      await session.press("down");
      await session.press("enter");
      const stacked = await harness.waitForSnapshot(
        session,
        (text) => !/▌.*▌/.test(text) && text.includes("1   -  export const alpha = 1;"),
        5_000,
      );

      expect(stacked).not.toMatch(/▌.*▌/);
      expect(stacked).toContain("1   -  export const alpha = 1;");
    } finally {
      session.close();
    }
  });

  test("direct layout hotkeys can switch between split, stack, and auto in a real PTY", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).not.toMatch(/▌.*▌/);
      expect(initial).toContain("1   -  export const alpha = 1;");

      await session.press("1");
      const split = await harness.waitForSnapshot(
        session,
        (text) => /▌.*▌/.test(text) && harness.countMatches(text, /alpha\.ts/g) >= 2,
        5_000,
      );

      expect(split).toMatch(/▌.*▌/);

      await session.press("2");
      const stack = await harness.waitForSnapshot(
        session,
        (text) => !/▌.*▌/.test(text) && text.includes("1   -  export const alpha = 1;"),
        5_000,
      );

      expect(stack).not.toMatch(/▌.*▌/);
      expect(stack).toContain("1   -  export const alpha = 1;");

      await session.press("0");
      const auto = await harness.waitForSnapshot(
        session,
        (text) => /▌.*▌/.test(text) && harness.countMatches(text, /alpha\.ts/g) >= 2,
        5_000,
      );

      expect(auto).toMatch(/▌.*▌/);
    } finally {
      session.close();
    }
  });

  test("layout hotkeys preserve the current review position in a real PTY", async () => {
    const fixture = harness.createScrollableFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 220,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line01 = 101");
      expect(initial).not.toContain("line08 = 108");

      let anchored = initial;
      for (let index = 0; index < 24; index += 1) {
        await session.press("down");
        await session.waitIdle({ timeout: 200 });
        anchored = await session.text({ immediate: true });
        if (anchored.includes("line08 = 108") && !anchored.includes("line01 = 101")) {
          break;
        }
      }

      const anchoredLineNumber = anchored.match(/line(\d{2}) =/)?.[1];

      expect(anchored).toContain("line08 = 108");
      expect(anchored).not.toContain("line01 = 101");
      expect(anchoredLineNumber).toBeDefined();

      await session.press("2");
      const stacked = await harness.waitForSnapshot(
        session,
        (text) => !/▌.*▌/.test(text) && text.includes(`line${anchoredLineNumber} =`),
        5_000,
      );

      expect(stacked).toContain(`line${anchoredLineNumber} =`);

      await session.press("1");
      const split = await harness.waitForSnapshot(
        session,
        (text) => /▌.*▌/.test(text) && text.includes(`line${anchoredLineNumber} =`),
        5_000,
      );

      expect(split).toContain(`line${anchoredLineNumber} =`);
    } finally {
      session.close();
    }
  });

  test("mouse wheel scrolling moves the review pane", async () => {
    const fixture = harness.createScrollableFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 220,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("line01 = 101");
      expect(initial).not.toContain("line08 = 108");

      // Give slower CI PTYs one extra settle point so the first wheel event is not dropped.
      await session.waitIdle({ timeout: 200 });
      await session.scrollDown(12);
      const scrolled = await harness.waitForSnapshot(
        session,
        (text) =>
          !text.includes("line01 = 101") &&
          (text.includes("line11 = 111") || text.includes("line12 = 112")),
        5_000,
      );

      expect(scrolled).not.toContain("line01 = 101");
      expect(scrolled.includes("line11 = 111") || scrolled.includes("line12 = 112")).toBe(true);

      await session.scrollUp(12);
      const restored = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line01 = 101"),
        5_000,
      );

      expect(restored).toContain("line01 = 101");
    } finally {
      session.close();
    }
  });

  test("arrow-key horizontal scrolling reveals hidden code columns in a real PTY", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 102,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("this is a very long");
      expect(initial).not.toContain("ge';");

      let shifted = initial;
      for (let index = 0; index < 96; index += 1) {
        await session.press("right");
        shifted = await session.text();
        if (shifted.includes("ge';")) {
          break;
        }
      }

      expect(shifted).toContain("ge';");
      expect(shifted).not.toContain("this is a very long");

      let restored = shifted;
      for (let index = 0; index < 96; index += 1) {
        await session.press("left");
        restored = await session.text();
        if (restored.includes("this is a very long") && !restored.includes("ge';")) {
          break;
        }
      }

      expect(restored).toContain("this is a very long");
      expect(restored).not.toContain("ge';");
    } finally {
      session.close();
    }
  });

  test("wrap toggles reset horizontal code scrolling in a real PTY", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 102,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("this is a very long");
      expect(initial).not.toContain("ge';");

      let shifted = initial;
      for (let index = 0; index < 96; index += 1) {
        await session.press("right");
        shifted = await session.text();
        if (shifted.includes("ge';")) {
          break;
        }
      }

      expect(shifted).toContain("ge';");
      expect(shifted).not.toContain("this is a very long");

      await session.press("w");
      const wrapped = await harness.waitForSnapshot(
        session,
        (text) => text.includes("ge';"),
        5_000,
      );

      expect(wrapped).toContain("this is a very long");
      expect(wrapped).toContain("ge';");

      await session.press("w");
      const reset = await harness.waitForSnapshot(
        session,
        (text) => text.includes("this is a very long") && !text.includes("ge';"),
        5_000,
      );

      expect(reset).toContain("this is a very long");
      expect(reset).not.toContain("ge';");
    } finally {
      session.close();
    }
  });

  test("the first mouse-wheel step still advances content under the always-pinned file header above a collapsed gap", async () => {
    const fixture = harness.createCollapsedTopRepoFixture();
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

      expect(initial).toContain("aaa-collapsed.ts");
      expect(initial).toContain("··· 362 unchanged lines ···");
      expect(initial).not.toContain("366 - export const line366 = 366;");

      await session.scrollDown(1);
      const advanced = await harness.waitForSnapshot(
        session,
        (text) => text.includes("366 - export const line366 = 366;"),
        5_000,
      );

      expect(advanced).toContain("366 - export const line366 = 366;");
    } finally {
      session.close();
    }
  });

  test("one mouse-wheel step down then up restores the collapsed-gap view beneath the pinned file header", async () => {
    const fixture = harness.createCollapsedTopRepoFixture();
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
      const initialHeaderCount = harness.countMatches(initial, /aaa-collapsed\.ts/g);

      await session.scrollDown(1);
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("366 - export const line366 = 366;"),
        5_000,
      );

      await session.scrollUp(1);
      const restored = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("··· 362 unchanged lines ···") &&
          harness.countMatches(text, /aaa-collapsed\.ts/g) === initialHeaderCount,
        5_000,
      );

      expect(restored).toContain("··· 362 unchanged lines ···");
      expect(restored).not.toContain("366 - export const line366 = 366;");
      expect(harness.countMatches(restored, /aaa-collapsed\.ts/g)).toBe(initialHeaderCount);
    } finally {
      session.close();
    }
  });
});
