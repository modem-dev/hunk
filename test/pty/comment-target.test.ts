import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Session } from "tuistory";
import { createPtyHarness, lineIndexOf, moveMouse, rowCellBackgrounds, sleep } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

/** Read the [LR]-line label the draft card reports, or null while none is visible. */
function draftTarget(text: string): string | null {
  return /Draft note[^ ]* - [^R]*([LR]\d+)/.exec(text)?.[1] ?? null;
}

/** Find the terminal row carrying the current-line highlight tint and return its text. */
function highlightedRowText(session: Session): string | null {
  // The two hexes are the runtime blends cursorLineHighlightBg paints over context and
  // changed rows for the default theme; a theme or blend-ratio change invalidates them.
  const cursorTints = ["#373737", "#2a2a2a"];
  const data = session.getTerminalData();
  for (const line of data.lines) {
    const bgs = line.spans.map((span) => span.bg ?? "");
    if (bgs.some((bg) => cursorTints.includes(bg))) {
      return line.spans.map((span) => span.text).join("");
    }
  }
  return null;
}

describe("PTY comment target", () => {
  test("a wheel roundtrip does not move the comment target off the clicked line", async () => {
    // The reported drift: click a line (cursor adopts it, pointer rests there),
    // fidget the wheel down a few and back up, press 'c'. The viewport returns to
    // where it started, but the line cursor can end up parked on a different stop —
    // and the draft opens a line or two (or a whole gap) away from the clicked line.
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 16,
    });

    try {
      await session.waitForText(/line1 = 100/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      // Click the row showing line2 (terminal data row 6; SGR encodes +1).
      session.writeRaw("\x1b[<0;9;7M");
      session.writeRaw("\x1b[<0;9;7m");
      await session.waitIdle({ timeout: 300 });
      expect(highlightedRowText(session)).toContain("line2 = 2;");

      // Fidget: wheel down 3, then up 3 — net zero viewport movement.
      for (let i = 0; i < 3; i += 1) {
        await session.scrollDown(1);
        await session.waitIdle({ timeout: 120 });
      }
      for (let i = 0; i < 3; i += 1) {
        await session.scrollUp(1);
        await session.waitIdle({ timeout: 120 });
      }
      await session.waitIdle({ timeout: 400 });

      // The viewport is back where it started with no deliberate cursor move in
      // between. The highlight must still sit on line2 — and so must the draft.
      const highlight = highlightedRowText(session);

      await session.press("c");
      await session.waitIdle({ timeout: 400 });
      const text = await session.text({ immediate: true });
      const target = draftTarget(text);

      expect(highlight).toContain("line2 = 2;");
      expect(target).toBe("R2");
    } finally {
      session.close();
    }
  });

  test("a longer wheel roundtrip does not strand the cursor in a scrolled-away hunk", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 16,
    });

    try {
      await session.waitForText(/line1 = 100/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      session.writeRaw("\x1b[<0;9;7M");
      session.writeRaw("\x1b[<0;9;7m"); // click line2
      await session.waitIdle({ timeout: 300 });

      // Down 5, up 5: the roundtrip crosses the hunk boundary and back.
      for (let i = 0; i < 5; i += 1) {
        await session.scrollDown(1);
        await session.waitIdle({ timeout: 120 });
      }
      for (let i = 0; i < 5; i += 1) {
        await session.scrollUp(1);
        await session.waitIdle({ timeout: 120 });
      }
      await session.waitIdle({ timeout: 400 });

      await session.press("c");
      await session.waitIdle({ timeout: 400 });
      const text = await session.text({ immediate: true });
      const target = draftTarget(text);

      // The draft must not anchor in the second hunk (R5x) after the viewport
      // returned to the first one — the classic "comment opened far away" report.
      expect(target).toBe("R2");
    } finally {
      session.close();
    }
  });

  test("stepping mid-roundtrip ends the unwind at the new stop", async () => {
    // The unwind memory exists for wheel-only journeys: a deliberate cursor step
    // between the two wheel legs ends the unwind, so the journey home must keep
    // the stepped stop instead of restoring the pre-clamp stop.
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 16,
    });

    try {
      await session.waitForText(/line1 = 100/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      session.writeRaw("\x1b[<0;9;7M");
      session.writeRaw("\x1b[<0;9;7m"); // click line2
      await session.waitIdle({ timeout: 300 });

      await session.scrollDown(3);
      await session.waitIdle({ timeout: 200 });
      await session.press("j");
      await session.waitIdle({ timeout: 200 });
      await session.scrollUp(3);
      await session.waitIdle({ timeout: 400 });

      await session.press("c");
      await session.waitIdle({ timeout: 400 });
      const text = await session.text({ immediate: true });

      // The stepped stop owns the draft. The step lands on R4, not R3: the wheel
      // leg down first clamped the cursor to a viewport-edge stop, and `j` stepped
      // from there. What matters is that the unwind does not restore R2 — without
      // the deliberate-move reset, this roundtrip opens the draft on the clicked
      // line the reviewer stepped away from.
      expect(draftTarget(text)).toBe("R4");
    } finally {
      session.close();
    }
  });

  test("stepping the cursor retires a stale hover target for the next comment", async () => {
    // Hovering arms an add-note affordance on the hovered row. Arrow keys and `j` move
    // the current line but leave the pointer stationary, so the affordance used to stay
    // armed at the old row and the next `c` opened the draft there instead of on the
    // highlighted line the reviewer moved to.
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/line1 = 100/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      // Hover the row showing line2. The badge appears on the same row.
      const hoverRow = initial.split("\n").findIndex((line) => line.includes("line2 = 2;"));
      expect(hoverRow).toBeGreaterThan(0);
      await moveMouse(session, 8, hoverRow - 1);
      await session.waitForText(/\[\+\]/, { timeout: 5_000 });

      // Step the cursor to line4 without moving the pointer or scrolling.
      for (let step = 0; step < 3; step += 1) {
        await session.press("j");
      }
      await session.waitIdle({ timeout: 300 });

      // The highlight is on line3 after three steps from the initial old-side line1
      // stop (the first step adopts line1's new side); the pointer still rests over
      // line2's row. The current line owns the comment; the retired hover must not.
      const draft = await harness.pressAndWaitForText(session, "c", /Draft note/, {
        timeout: 5_000,
      });
      expect(draftTarget(draft)).toBe("R3");

      // The retirement is not permanent: hovering a new row re-arms its affordance,
      // on the hovered row itself.
      const withDraft = await session.text({ immediate: true });
      const newRow = withDraft.split("\n").findIndex((line) => line.includes("line4 = 4;"));
      expect(newRow).toBeGreaterThan(0);
      await moveMouse(session, 8, newRow - 1);
      const rearmed = await session.waitForText(/\[\+\]/, { timeout: 5_000 });
      const badgeRow = rearmed
        .split("\n")
        .findIndex((line) => line.includes("line4 = 4;") && line.includes("[+]"));
      expect(badgeRow).toBe(newRow);
    } finally {
      session.close();
    }
  });

  test("a drag across exactly two rows commits and shows the selection actions", async () => {
    // A two-row vertical drag used to fall inside the click slop and was swallowed as a
    // jittered click: no selection painted and no action bar. It is a deliberate gesture.
    const fixture = harness.createScrollableFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 120,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/export const line06 = 6;/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });
      const startRow = lineIndexOf(initial, "export const line02 = 2;") - 1;
      expect(startRow).toBeGreaterThan(0);

      // Drag from line2's row to the adjacent row below, then release.
      const before = rowCellBackgrounds(session, startRow);
      session.writeRaw(`\x1b[<0;31;${startRow + 1}M`);
      await sleep(20);
      session.writeRaw(`\x1b[<32;31;${startRow + 2}M`);
      await sleep(20);
      session.writeRaw(`\x1b[<0;31;${startRow + 2}m`);
      await session.waitForText(/c Comment\s+y Copy\s+Esc Clear/, { timeout: 5_000 });

      // The first row's paint changed: the drag committed as a real selection.
      expect(rowCellBackgrounds(session, startRow)).not.toEqual(before);
    } finally {
      session.close();
    }
  });
});
