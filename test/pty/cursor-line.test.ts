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

  test("saves a note on a line revealed from expanded source", async () => {
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
      await session.waitIdle({ timeout: 500 });
      await session.press("c");
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Expanded source note.");
      await session.type("\x13");

      const saved = await session.waitForText(/Your note/, { timeout: 5_000 });
      expect(saved).toContain("Expanded source note.");
      expect(lineIndexOf(saved, "Your note")).toBe(lineIndexOf(saved, "hiddenLine01") + 1);
    } finally {
      session.close();
    }
  });

  test("renders a saved note beside a later hunk's expanded source row", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "stack"],
      cols: 140,
      rows: 18,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, { timeout: 15_000 });
      await session.press("]");
      await session.waitIdle({ timeout: 300 });
      await session.press("z");
      await harness.waitForSnapshot(session, (text) => text.includes("line5 = 5"), 5_000);
      await session.waitIdle({ timeout: 500 });
      await session.press("c");
      await session.waitForText(/Draft note/, { timeout: 5_000 });
      await session.type("Later expanded note.");
      await session.type("\x13");

      const saved = await session.waitForText(/Your note/, { timeout: 5_000 });
      expect(saved).toContain("Later expanded note.");
      expect(lineIndexOf(saved, "Your note")).toBe(lineIndexOf(saved, "line5 = 5") + 1);
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
