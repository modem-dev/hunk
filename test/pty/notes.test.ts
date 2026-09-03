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
        "--files",
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
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).not.toContain("Adds bonus export.");

      await session.press("a");
      const withNotes = await session.waitForText(/Adds bonus export\./, { timeout: 5_000 });

      expect(withNotes).toContain("Highlights the follow-up addition for review.");
      expect(withNotes).not.toContain("STML ACTIVE");

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

  test("a note anchored to collapsed lines renders inside its owning hunk", async () => {
    const fixture = harness.createGapAnnotatedAgentFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--files",
        fixture.before,
        fixture.after,
        "--mode",
        "split",
        "--agent-context",
        fixture.agentContext,
      ],
      cols: 140,
      rows: 30,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.press("a");
      const withNotes = await session.waitForText(/GAP NOTE/, { timeout: 5_000 });

      // Lines 6-7 are collapsed away, so the note hangs from the hunk that owns the gap:
      // it lands just below that hunk's first row, not at the top of the file.
      const noteIndex = lineIndexOf(withNotes, "GAP NOTE");
      expect(noteIndex).toBeGreaterThan(lineIndexOf(withNotes, "line8 = 8;"));
      expect(noteIndex).toBeLessThan(lineIndexOf(withNotes, "line9 = 9;"));
    } finally {
      session.close();
    }
  });

  test("experimental launches render STML note bodies", async () => {
    const fixture = harness.createAgentFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--files",
        fixture.before,
        fixture.after,
        "--mode",
        "split",
        "--agent-context",
        fixture.agentContext,
        "--experimental",
      ],
      cols: 140,
      rows: 20,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.press("a");
      const withMarkup = await session.waitForText(/STML ACTIVE/, { timeout: 5_000 });

      expect(withMarkup).not.toContain("Highlights the follow-up addition for review.");
    } finally {
      session.close();
    }
  });

  test("opening a draft keeps the active line fixed while pushing following code down", async () => {
    const fixture = harness.createScrollableFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "stack"],
      cols: 120,
      rows: 26,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      await session.waitIdle({ timeout: 500 });
      for (let index = 0; index < 8; index += 1) {
        await session.press("down");
      }

      const beforePushedDraft = await session.text({ immediate: true });
      const firstActiveLine = "export const line09 = 9;";
      const followingLine = "export const line10 = 10;";
      const firstActiveRow = lineIndexOf(beforePushedDraft, firstActiveLine);
      const followingRowBefore = lineIndexOf(beforePushedDraft, followingLine);

      await session.press("c");
      await session.waitForText(/Draft note - before\.ts -> after\.ts L9/, { timeout: 5_000 });
      await sleep(100);
      const pushedDraft = await session.text({ immediate: true });

      expect(firstActiveRow).toBeGreaterThan(0);
      expect(lineIndexOf(pushedDraft, firstActiveLine)).toBe(firstActiveRow);
      expect(lineIndexOf(pushedDraft, "Draft note")).toBe(firstActiveRow + 1);
      expect(lineIndexOf(pushedDraft, followingLine)).toBeGreaterThan(followingRowBefore);

      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => !text.includes("Draft note"), 5_000);
      for (let index = 0; index < 8; index += 1) {
        await session.press("down");
      }

      const beforeBottomDraft = await session.text({ immediate: true });
      const bottomActiveLine = "export const line17 = 17;";
      const bottomActiveRow = lineIndexOf(beforeBottomDraft, bottomActiveLine);
      expect(bottomActiveRow).toBeGreaterThan(0);

      await session.press("c");
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await sleep(100);
      const bottomDraft = await session.text({ immediate: true });

      expect(lineIndexOf(bottomDraft, bottomActiveLine)).toBe(bottomActiveRow);
      expect(lineIndexOf(bottomDraft, "Draft note")).toBe(bottomActiveRow + 1);
    } finally {
      session.close();
    }
  });

  test("cursor-line-off drafts still reveal their default target and full composer", async () => {
    const fixture = harness.createScrollableFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--files",
        fixture.before,
        fixture.after,
        "--mode",
        "stack",
        "--cursor-line",
        "off",
      ],
      cols: 120,
      rows: 12,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      // Paging is a render, not a keypress: snapshotting before it settles reads
      // the pre-scroll frame. The same page-down assertion in cursor-line.test.ts
      // brackets the key with the same waits.
      await session.waitIdle({ timeout: 300 });
      await session.press("space");
      await session.waitIdle({ timeout: 400 });
      const paged = await session.text({ immediate: true });
      expect(paged).not.toContain("export const line01 = 1;");

      await session.press("c");
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await sleep(100);
      const draft = await session.text({ immediate: true });

      expect(draft).toContain("Draft note - before.ts -> after.ts R1");
      expect(draft).toContain("Esc cancel");
    } finally {
      session.close();
    }
  });

  test("user notes can be drafted and saved inline in a real PTY", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 20,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await session.press("c");
      const freshDraft = await session.waitForText(/Draft note/, { timeout: 5_000 });
      // The "c" that opened the note must not be inserted into the editor. A fresh, empty draft
      // shows its placeholder; if the opening keystroke leaked in, the editor would hold "c" and
      // the placeholder would be gone.
      expect(freshDraft).toContain("Write a note");
      const composerBorder = freshDraft
        .split("\n")
        .find((line) => line.includes("Ctrl+S save") && line.includes("Esc cancel"));
      expect(composerBorder?.trimStart().startsWith("╰")).toBe(true);
      expect(composerBorder?.trimEnd().endsWith("╯")).toBe(true);

      await session.type("Please cover this edge case.");

      const draftBeforeNewline = await session.waitForText(/Please cover this edge case\./, {
        timeout: 5_000,
      });
      const saveRowBeforeNewline = draftBeforeNewline
        .split("\n")
        .findIndex((line) => line.includes("Ctrl+S save") && line.includes("Esc cancel"));
      expect(saveRowBeforeNewline).toBeGreaterThanOrEqual(0);

      await session.type("\x0a");
      await harness.waitForSnapshot(
        session,
        (text) => {
          const saveRowAfterNewline = text
            .split("\n")
            .findIndex((line) => line.includes("Ctrl+S save") && line.includes("Esc cancel"));
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

  test("saved notes can be edited and replied to through clickable threaded actions", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "stack"],
      cols: 100,
      rows: 30,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      await session.press("c");
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Root review note.");
      await session.waitForText(/Root review note\./, { timeout: 5_000 });
      await session.type("\x13");
      const root = await session.waitForText(/Root review note\./, { timeout: 5_000 });
      expect(root).not.toContain("r reply");
      expect(root).toMatch(/before\.ts -> after\.ts [LR]1/);

      const revealActionsForBody = async (body: string) => {
        const snapshot = await session.waitForText(
          new RegExp(body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          {
            timeout: 5_000,
          },
        );
        const row = lineIndexOf(snapshot, body);
        const column = snapshot.split("\n")[row]!.indexOf(body) + 1;
        await moveMouse(session, 0, 0);
        await moveMouse(session, column, row);
        return session.waitForText(/r reply e edit/, { timeout: 5_000 });
      };

      const hoveredRoot = await revealActionsForBody("Root review note.");
      const rootBottomBorder = hoveredRoot
        .split("\n")
        .find((line) => line.includes("r reply e edit d delete"));
      expect(rootBottomBorder?.trimStart().startsWith("╰")).toBe(true);
      expect(rootBottomBorder?.trimEnd().endsWith("╯")).toBe(true);

      const rootRowBeforeEdit = lineIndexOf(hoveredRoot, "Root review note.");
      await session.click(/e edit/);
      const editing = await session.waitForText(/Edit note/, { timeout: 5_000 });
      expect(editing).toContain("Root review note.");
      expect(lineIndexOf(editing, "Root review note.")).toBe(rootRowBeforeEdit);
      await session.type("Updated. ");
      await session.waitForText(/Updated\. Root review note\./, { timeout: 5_000 });
      await moveMouse(session, 0, 0);
      await session.type("\x13");
      const edited = await session.waitForText(/Updated\. Root review note\./, { timeout: 5_000 });
      expect((edited.match(/Your note/g) ?? []).length).toBe(1);
      expect(edited).not.toContain("r reply");

      const rootBeforeReply = await revealActionsForBody("Updated. Root review note.");
      const rootRowBeforeReply = lineIndexOf(rootBeforeReply, "Updated. Root review note.");
      await session.click(/r reply/);
      const replying = await session.waitForText(/╰─╭─ Reply -/, { timeout: 5_000 });
      expect(lineIndexOf(replying, "Updated. Root review note.")).toBe(rootRowBeforeReply);
      await session.type("First reply.");
      await session.waitForText(/First reply\./, { timeout: 5_000 });
      await session.type("\x13");
      const firstReply = await session.waitForText(/First reply\./, { timeout: 5_000 });
      expect(firstReply).toMatch(/╰─╭─ Your note/);

      await revealActionsForBody("First reply.");
      await session.click(/r reply/);
      await session.waitForText(/╰─╭─ Reply -/, { timeout: 5_000 });
      await session.type("Nested reply.");
      await session.waitForText(/Nested reply\./, { timeout: 5_000 });
      await session.type("\x13");

      const nested = await session.waitForText(/Nested reply\./, { timeout: 5_000 });
      expect(nested).toMatch(/╰─╭─ Your note/);

      await revealActionsForBody("Updated. Root review note.");
      await session.click(/r reply/);
      const siblingDraft = await session.waitForText(/╰─╭─ Reply -/, { timeout: 5_000 });
      expect(siblingDraft).toMatch(/├─╭─ Your note/);
      expect(siblingDraft).toMatch(/│ ╰─╭─ Your note/);
      await session.click(/Esc cancel/);
      await harness.waitForSnapshot(session, (text) => !text.includes("╭─ Reply -"), 5_000);

      await session.type("E");
      await session.waitForText(/╭─ Edit note -/, { timeout: 5_000 });
      await session.click(/Esc cancel/);
      await harness.waitForSnapshot(session, (text) => !text.includes("╭─ Edit note -"), 5_000);
      await session.type("R");
      const keyboardReply = await session.waitForText(/╭─ Reply -/, { timeout: 5_000 });

      const threadedTitles = keyboardReply
        .split("\n")
        .filter((line) => line.includes("╭─ Your note"));
      expect(threadedTitles.length).toBeGreaterThanOrEqual(3);
      expect(threadedTitles[1]!.indexOf("╭")).toBeGreaterThan(threadedTitles[0]!.indexOf("╭"));

      await session.click(/Esc cancel/);
      await harness.waitForSnapshot(session, (text) => !text.includes("╭─ Reply -"), 5_000);
      await revealActionsForBody("Nested reply.");
      await session.click(/d delete/);
      const deletedLeaf = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Nested reply."),
        5_000,
      );
      expect(deletedLeaf).not.toContain("Nested reply.");
    } finally {
      session.close();
    }
  });

  test("CJK draft notes wrap instead of scrolling out of view in a real PTY", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await session.press("c");
      await session.waitForText(/Draft note/, { timeout: 5_000 });

      // 48 characters, 86 cells: past the wrap point of any reasonable
      // composer width, and long enough that a code-unit row estimate would
      // keep the composer at one row.
      const body =
        "这个包主要是为了在普通的chatmodel外面包一层,把工具调用的编号统一转换后再返回给调用方使用";
      await session.type(body);

      const draft = await session.waitForText(/这个包主要是为了/, { timeout: 5_000 });
      expect(draft).toContain(body.slice(0, 10));
      expect(draft).toContain(body.slice(-6));

      await session.type("\x13");
      const savedNote = await session.waitForText(/Your note/, { timeout: 5_000 });
      expect(savedNote).toContain(body.slice(0, 10));
      expect(savedNote).toContain(body.slice(-6));
    } finally {
      session.close();
    }
  });

  test("rapid Ctrl+S presses save a draft note exactly once", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });

      await session.press("c");
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Save exactly one note.");
      await session.waitForText(/Save exactly one note\./, { timeout: 5_000 });

      // Send both Ctrl+S bytes in one PTY write so the second save request runs
      // before the draft-clearing state update commits.
      session.writeRaw("\x13\x13");
      await session.waitIdle();

      const saved = await session.waitForText(/Your note/, { timeout: 5_000 });
      expect(saved).toContain("Save exactly one note.");

      // A duplicated save renders numbered "Your note 1/2" cards; a single save must not.
      await sleep(250);
      const settled = await session.text({ immediate: true });
      expect(settled).not.toContain("Your note 1/");
      expect((settled.match(/Your note/g) ?? []).length).toBe(1);
    } finally {
      session.close();
    }
  });

  test("add-note affordance appears only after mouse movement in a real PTY", async () => {
    const fixture = harness.createScrollableFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 12,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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

  test("a single Escape cancels a freshly opened empty draft note", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 20,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      // Open an empty draft via the keyboard and immediately cancel it. The very first Escape must
      // close it — a regression once required two presses because the focus area had not yet
      // settled to the note when the first Escape arrived.
      await session.press("c");
      await session.waitForText(/Draft note/, { timeout: 5_000 });

      await session.press("escape");
      const cancelled = await harness.waitForSnapshot(
        session,
        (text) => !text.includes("Draft note"),
        5_000,
      );

      expect(cancelled).not.toContain("Draft note");
    } finally {
      session.close();
    }
  });

  test("clicked add-note drafts can cancel and save with keyboard shortcuts", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 20,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "stack"],
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
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
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
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/keep = true/, {
        timeout: 15_000,
      });
      const targetRow = lineIndexOf(initial, "keep = true");
      expect(targetRow).toBeGreaterThan(0);

      // Put the keyboard cursor on the deletion, then click the separate context row. Opening the
      // clicked draft must preserve the clicked row rather than the old keyboard-cursor anchor.
      await session.press("down");
      const beforeDraft = await session.text({ immediate: true });
      const clickedRowBefore = lineIndexOf(beforeDraft, "keep = true");
      await revealAddNoteOnRow(session, clickedRowBefore);
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await sleep(100);
      const withDraft = await session.text({ immediate: true });
      expect(lineIndexOf(withDraft, "keep = true")).toBe(clickedRowBefore);
      expect(lineIndexOf(withDraft, "Draft note")).toBeGreaterThan(clickedRowBefore);

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
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
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

      // Cancel from the focused editor so the tight viewport can keep the target line fixed even
      // when the form's action row is intentionally below the visible bounds.
      await session.press("escape");
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

  test("draft note focus blocks pager shortcuts until cancelled", async () => {
    const fixture = harness.createPagerPatchFixture();
    const session = await harness.launchHunk({
      args: ["patch", fixture.patchFile, "--pager"],
      cols: 120,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/before_01/, { timeout: 15_000 });
      const targetRow = lineIndexOf(initial, "before_01");
      const sidebarRow = /\bM scroll\.ts\s+\+40 -40/;

      expect(targetRow).toBeGreaterThan(0);
      expect(initial).not.toMatch(sidebarRow);

      await revealAddNoteNear(session, targetRow);
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("sidebar-trigger text");
      const whileFocused = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Draft note") && text.includes("sidebar-trigger text"),
        5_000,
      );

      expect(whileFocused).not.toMatch(sidebarRow);

      await session.click(/Esc cancel/);
      await harness.waitForSnapshot(session, (text) => !text.includes("Draft note"), 5_000);
      await session.press("s");
      const afterCancel = await harness.waitForSnapshot(
        session,
        (text) => sidebarRow.test(text),
        5_000,
      );

      expect(afterCancel).toMatch(sidebarRow);
    } finally {
      session.close();
    }
  });

  test("multiple add-note drafts can be saved on one hunk", async () => {
    const fixture = harness.createDeletionOnlyFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
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
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 20,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      await revealAddNoteAffordance(session, 8, [4, 5]);
      await session.click(/\[\+\]/);
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Cancel this draft.");
      await session.click(/Esc cancel/);
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
      await session.click(/Ctrl\+S save/);
      const saved = await session.waitForText(/Your note/, { timeout: 5_000 });

      expect(saved).toContain("Save this clicked draft.");
    } finally {
      session.close();
    }
  });
});
