import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPtyHarness, lineIndexOf, measureKeyScroll } from "./harness";

const harness = createPtyHarness();
const CURRENT_LINE_LENS_EXTENSION = resolve(
  fileURLToPath(new URL("./fixtures/current-line-lens", import.meta.url)),
);

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY current line", () => {
  test("stepping moves the current line before it moves the viewport", async () => {
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["show", "HEAD", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      expect(await measureKeyScroll(session, "j", 12)).toBe(0);

      let stepsBeforeScrolling = 1;
      let firstScroll = 0;
      for (let step = 0; step < 40 && firstScroll === 0; step += 1) {
        firstScroll = await measureKeyScroll(session, "j", 12);
        stepsBeforeScrolling += 1;
      }

      expect(stepsBeforeScrolling).toBeGreaterThan(5);
      expect(firstScroll).toBeGreaterThan(0);

      expect(await measureKeyScroll(session, "j", 12)).toBe(1);
      expect(await measureKeyScroll(session, "j", 12)).toBe(1);
      expect(await measureKeyScroll(session, "k", 12)).toBe(0);
    } finally {
      session.close();
    }
  });

  test("a current-line pane pins old above new and hides in stack mode", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        fixture.before,
        fixture.after,
        "--mode",
        "split",
        "--extension",
        CURRENT_LINE_LENS_EXTENSION,
      ],
      cols: 140,
      rows: 18,
    });

    try {
      const split = await session.waitForText(/Current line · old above, new below/, {
        timeout: 15_000,
      });
      const splitLines = split.split("\n");
      const lensIndex = lineIndexOf(split, "Current line");
      expect(splitLines[lensIndex + 1]).toContain("export const message = 'short';");
      expect(splitLines[lensIndex + 2]).toContain("this is a very long wrapped line");

      await session.press("2");
      await harness.waitForSnapshot(session, (text) => !text.includes("Current line"), 5_000);

      await session.press("1");
      await session.waitForText(/Current line · old above, new below/, { timeout: 5_000 });
    } finally {
      session.close();
    }
  });

  test("stepping updates lens content without moving its fixed rectangle", async () => {
    const fixture = harness.createWideCharacterFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        fixture.before,
        fixture.after,
        "--mode",
        "split",
        "--extension",
        CURRENT_LINE_LENS_EXTENSION,
      ],
      cols: 140,
      rows: 18,
    });

    try {
      const initial = await session.waitForText(/Current line · old above, new below/, {
        timeout: 15_000,
      });
      const lensRow = lineIndexOf(initial, "Current line");
      expect(initial.split("\n")[lensRow + 1]).toContain("日本語");
      expect(initial.split("\n")[lensRow + 2]).toContain("한국어");

      await harness.ensureKeyboardIsLive(session);
      for (let step = 0; step < 4; step += 1) await session.press("j");
      const moved = await session.waitForText(/plain = 'after'/, { timeout: 5_000 });
      expect(lineIndexOf(moved, "Current line")).toBe(lensRow);
      expect(moved.split("\n")[lensRow + 1]).toContain("plain = 'before'");
      expect(moved.split("\n")[lensRow + 2]).toContain("plain = 'after'");
    } finally {
      session.close();
    }
  });

  test("a held step key advances one line per press", async () => {
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["show", "HEAD", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      let scrolled = 0;
      for (let step = 0; step < 40 && scrolled === 0; step += 1) {
        scrolled = await measureKeyScroll(session, "j", 12);
      }
      expect(scrolled).toBeGreaterThan(0);

      const before = (await session.text({ immediate: true })).split("\n");
      const anchor = before[12]?.trim() ?? "";
      expect(anchor.length).toBeGreaterThan(0);

      // A held key arrives as one chunk and drains synchronously, so every press in the burst
      // has to see the move the press before it made.
      await session.writeRaw("jjjjj");
      await session.waitIdle({ timeout: 800 });

      const after = (await session.text({ immediate: true })).split("\n");
      expect(12 - after.findIndex((line) => line.trim() === anchor)).toBe(5);
    } finally {
      session.close();
    }
  });

  test("stepping reaches the lines an expanded gap reveals", async () => {
    const fixture = harness.createExpandableContextFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "stack"],
      cols: 140,
      rows: 16,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.press("z");
      await harness.waitForSnapshot(session, (text) => text.includes("hiddenLine01"), 5_000);
      // The revealed rows reach navigation one commit after they reach the screen.
      await session.waitIdle({ timeout: 500 });

      await session.press("k");
      await session.waitIdle({ timeout: 200 });
      await session.press("c");
      const draft = await session.waitForText(/Draft note/, { timeout: 5_000 });

      expect(lineIndexOf(draft, "Draft note")).toBe(lineIndexOf(draft, "hiddenLine01") + 1);
    } finally {
      session.close();
    }
  });

  test("expanding a gap moves the current line into it and collapsing puts it back", async () => {
    const fixture = harness.createExpandableContextFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "stack"],
      cols: 140,
      rows: 16,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });
      await session.press("c");
      const beforeExpand = await session.waitForText(/Draft note/, { timeout: 5_000 });
      const startRow = /Draft note[^R]*R(\d+)/.exec(beforeExpand)?.[1];
      expect(startRow).toBeDefined();
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => !text.includes("Draft note"), 5_000);

      await session.press("z");
      await harness.waitForSnapshot(session, (text) => text.includes("hiddenLine01"), 5_000);
      await session.waitIdle({ timeout: 500 });
      await session.press("c");
      const expanded = await session.waitForText(/Draft note/, { timeout: 5_000 });

      expect(expanded).toContain("R1 ");
      expect(lineIndexOf(expanded, "Draft note")).toBe(lineIndexOf(expanded, "hiddenLine01") + 1);
      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => !text.includes("Draft note"), 5_000);

      await session.press("z");
      await harness.waitForSnapshot(session, (text) => !text.includes("hiddenLine01"), 5_000);
      await session.waitIdle({ timeout: 500 });
      await session.press("c");
      const collapsed = await session.waitForText(/Draft note/, { timeout: 5_000 });

      expect(collapsed).toContain(`R${startRow} `);
    } finally {
      session.close();
    }
  });

  test("paging leaves the current line on screen", async () => {
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["show", "HEAD", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      await session.press("space");
      await session.waitIdle({ timeout: 400 });

      expect(await measureKeyScroll(session, "j", 12)).toBeLessThanOrEqual(1);
    } finally {
      session.close();
    }
  });

  test("a note after paging opens where the reviewer is looking", async () => {
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["show", "HEAD", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      await session.press("space");
      await session.waitIdle({ timeout: 400 });
      const paged = (await session.text({ immediate: true })).split("\n");
      const anchor = paged[12]?.trim() ?? "";
      expect(anchor.length).toBeGreaterThan(0);

      await session.press("c");
      const draft = await session.waitForText(/Draft note/, { timeout: 5_000 });

      expect(draft).toContain(anchor);
    } finally {
      session.close();
    }
  });

  test("a note anchors at the current line instead of the top of the hunk", async () => {
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["show", "HEAD", "--mode", "stack"],
      cwd: fixture.dir,
      cols: 120,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.waitIdle({ timeout: 300 });

      await session.press("c");
      const draftAtTop = await session.waitForText(/Draft note/, { timeout: 5_000 });
      const draftRowAtTop = lineIndexOf(draftAtTop, "Draft note");
      expect(draftRowAtTop).toBeGreaterThan(0);

      await session.press("escape");
      await harness.waitForSnapshot(session, (text) => !text.includes("Draft note"), 5_000);

      for (let step = 0; step < 4; step += 1) {
        await session.press("j");
        await session.waitIdle({ timeout: 200 });
      }

      await session.press("c");
      const draftAtCursor = await session.waitForText(/Draft note/, { timeout: 5_000 });

      expect(lineIndexOf(draftAtCursor, "Draft note")).toBeGreaterThan(draftRowAtTop);
    } finally {
      session.close();
    }
  });
});
