import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

/** Return the file named on the sidebar row that carries the selected-file marker. */
function selectedSidebarFile(text: string) {
  for (const line of text.split("\n")) {
    const match = /^\s*▌\s+\S\s+(file-\d\d\.ts)/.exec(line);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/** Report whether the sidebar lists a file row, selected or not. */
function sidebarLists(text: string, file: string) {
  return new RegExp(`^\\s*▌?\\s+\\S\\s+${file.replace(".", "\\.")}\\s`, "m").test(text);
}

describe("PTY sidebar selection follow", () => {
  test("resizing keeps a deep selection visible without capturing ordinary sidebar scrolling", async () => {
    const fixture = harness.createManyFileSidebarRepoFixture(60);
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split", "--sidebar"],
      cwd: fixture.dir,
      cols: 100,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      session.writeRaw(".".repeat(50));
      await harness.waitForSnapshot(
        session,
        (text) => selectedSidebarFile(text) === "file-50.ts",
        5_000,
      );

      for (const dimensions of [
        { cols: 160, rows: 32 },
        { cols: 100, rows: 24 },
        { cols: 100, rows: 18 },
      ]) {
        session.resize(dimensions);
        // A frame captured before the resize still contains the selected row; wait for redraw.
        await Bun.sleep(250);
        await harness.waitForSnapshot(
          session,
          (text) => selectedSidebarFile(text) === "file-50.ts" && text.includes("file50 = 150"),
          5_000,
        );
      }

      // Wheel events inside the sidebar may move away from the selected row without a snap-back.
      session.writeRaw("\u001b[<64;5;8M".repeat(12));
      await harness.waitForSnapshot(
        session,
        (text) => selectedSidebarFile(text) === null && sidebarLists(text, "file-30.ts"),
        5_000,
      );
      await Bun.sleep(250);
      expect(selectedSidebarFile(await session.text({ immediate: true }))).toBeNull();

      session.resize({ cols: 100, rows: 24 });
      await Bun.sleep(250);
      await harness.waitForSnapshot(
        session,
        (text) => selectedSidebarFile(text) === "file-50.ts",
        5_000,
      );
    } finally {
      session.close();
    }
  });

  test("a burst of next-file presses keeps the selected file inside the sidebar viewport", async () => {
    // Held-down `.` delivers key repeats faster than the renderer paints frames. The sidebar
    // must keep the selected row on screen even when several selections land between two
    // frames, on rows the render window has only just mounted.
    const fixture = harness.createManyFileSidebarRepoFixture(60);
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 160,
      rows: 24,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      expect(selectedSidebarFile(initial)).toBe("file-00.ts");
      expect(sidebarLists(initial, "file-40.ts")).toBe(false);

      // One write carries the whole burst so every press is handled before the next frame.
      session.writeRaw(".".repeat(40));
      await harness.waitForSnapshot(session, (text) => text.includes("file40 = 140"), 5_000);
      const revealed = await harness.waitForSnapshot(
        session,
        (text) => selectedSidebarFile(text) === "file-40.ts",
        3_000,
      );
      expect(sidebarLists(revealed, "file-00.ts")).toBe(false);

      // Stepping onward from a scrolled list must not snap the sidebar back to its top.
      session.writeRaw(".".repeat(10));
      await harness.waitForSnapshot(session, (text) => text.includes("file50 = 150"), 5_000);
      const revealedAgain = await harness.waitForSnapshot(
        session,
        (text) => selectedSidebarFile(text) === "file-50.ts",
        3_000,
      );
      expect(sidebarLists(revealedAgain, "file-00.ts")).toBe(false);
      expect(sidebarLists(revealedAgain, "file-40.ts")).toBe(true);
    } finally {
      session.close();
    }
  });
});
