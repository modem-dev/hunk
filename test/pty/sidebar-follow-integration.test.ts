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
