import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  createPtyHarness,
  lineIndexOf,
  moveMouse,
  revealAddNoteAffordance,
  revealAddNoteNear,
  revealAddNoteOnRow,
  sleep,
} from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY notes", () => {
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

      await revealAddNoteAffordance(session, 8, [4, 5]);
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Cancel this shortcut draft.");
      await session.type("\x1b");
      const cancelled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Draft note") && !text.includes("Cancel this shortcut draft."),
        5_000,
      );

      expect(cancelled).not.toContain("Your note");

      await revealAddNoteAffordance(session, 8, [4, 5]);
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

  test("clicking context-row add-note affordances can save draft notes", async () => {
    const fixture = harness.createDeletionOnlyFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/keep = true/, {
        timeout: 15_000,
      });
      const targetRow = lineIndexOf(initial, "keep = true");
      expect(targetRow).toBeGreaterThan(0);

      await revealAddNoteOnRow(session, targetRow);
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Save this context draft.");
      await session.press(["ctrl", "s"]);
      const saved = await session.waitForText(/Your note/, { timeout: 5_000 });

      expect(saved).toContain("Save this context draft.");
    } finally {
      session.close();
    }
  });

  test("draft note focus blocks app shortcuts until cancelled", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 104,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/line1 = 100/, {
        timeout: 15_000,
      });
      expect(initial).not.toContain("line60 = 6000");

      await session.press("c");
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Keep focus here");
      await session.press("]");
      const whileFocused = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Keep focus here]") && !text.includes("line60 = 6000"),
        5_000,
      );
      expect(whileFocused).toContain("Draft note");

      await session.type("\x1b");
      await harness.waitForSnapshot(session, (text) => !text.includes("Draft note"), 5_000);
      await session.press("]");
      const afterCancel = await harness.waitForSnapshot(
        session,
        (text) => text.includes("line60 = 6000"),
        5_000,
      );

      expect(afterCancel).not.toContain("Keep focus here]");
    } finally {
      session.close();
    }
  });

  test("multiple add-note drafts can be saved on one hunk", async () => {
    const fixture = harness.createDeletionOnlyFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/keep = true/, {
        timeout: 15_000,
      });
      const contextRow = lineIndexOf(initial, "keep = true");
      expect(contextRow).toBeGreaterThan(0);

      await revealAddNoteOnRow(session, contextRow);
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("First note on the context row.");
      await session.press(["ctrl", "s"]);
      const firstSaved = await session.waitForText(/First note on the context row\./, {
        timeout: 5_000,
      });
      const deletionRow = lineIndexOf(firstSaved, "removeMe");
      expect(deletionRow).toBeGreaterThan(0);

      await revealAddNoteNear(session, deletionRow);
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Second note on the deletion row.");
      await session.press(["ctrl", "s"]);
      const secondSaved = await session.waitForText(/Second note on the deletion row\./, {
        timeout: 5_000,
      });

      expect(secondSaved).toContain("First note on the context row.");
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

      await revealAddNoteAffordance(session, 8, [4, 5]);
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

      await revealAddNoteAffordance(session, 8, [4, 5]);
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
});
