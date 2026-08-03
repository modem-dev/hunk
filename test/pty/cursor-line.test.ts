import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createPtyHarness, lineIndexOf, measureKeyScroll } from "./harness";

const harness = createPtyHarness();

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

      // The cursor starts inside the first hunk, well above the fold, so the first step only
      // moves the highlight. This is the behavior `cursor_line = "off"` trades away.
      expect(await measureKeyScroll(session, "j", 12)).toBe(0);

      let stepsBeforeScrolling = 1;
      let firstScroll = 0;
      for (let step = 0; step < 40 && firstScroll === 0; step += 1) {
        firstScroll = await measureKeyScroll(session, "j", 12);
        stepsBeforeScrolling += 1;
      }

      // The highlight has to reach the bottom edge before the viewport moves at all.
      expect(stepsBeforeScrolling).toBeGreaterThan(5);
      expect(firstScroll).toBeGreaterThan(0);

      // From there the viewport follows the current line by exactly one row per step, rather
      // than jumping a quarter screen the way hunk reveal does.
      expect(await measureKeyScroll(session, "j", 12)).toBe(1);
      expect(await measureKeyScroll(session, "j", 12)).toBe(1);
      expect(await measureKeyScroll(session, "k", 12)).toBe(0);
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

      // The revealed line is a stop of its own, so the card lands under it rather than under the
      // first line the parsed hunk knows about.
      expect(lineIndexOf(draft, "Draft note")).toBe(lineIndexOf(draft, "hiddenLine01") + 1);
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

      // The page left the marker behind, so it re-anchors into the new viewport instead of
      // dragging the whole page back the moment the reviewer steps again.
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

      // Without a keyboard line target `c` would open the same card in the same place every time.
      expect(lineIndexOf(draftAtCursor, "Draft note")).toBeGreaterThan(draftRowAtTop);
    } finally {
      session.close();
    }
  });
});
