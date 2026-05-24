import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import stringWidth from "string-width";
import { createPtyHarness, dragMouse, rightmostColumnOf } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

describe("PTY layout", () => {
  test("split rows keep the center separator aligned after wide characters", async () => {
    const fixture = harness.createWideCharacterFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 140,
      rows: 16,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      const snapshot = await harness.waitForSnapshot(
        session,
        (text) => text.includes("日本語") && text.includes("plain"),
        5_000,
      );
      const lines = snapshot.split("\n");
      const wideLine = lines.find((line) => line.includes("日本語"));
      const plainLine = lines.find((line) => line.includes("plain"));

      expect(wideLine).toBeDefined();
      expect(plainLine).toBeDefined();
      if (!wideLine || !plainLine) {
        throw new Error(`Expected wide and plain split rows in snapshot:\n${snapshot}`);
      }

      const wideSeparatorIndex = wideLine.indexOf("▌", 1);
      const plainSeparatorIndex = plainLine.indexOf("▌", 1);

      expect(wideSeparatorIndex).toBeGreaterThan(0);
      expect(plainSeparatorIndex).toBeGreaterThan(0);
      expect(stringWidth(wideLine.slice(0, wideSeparatorIndex))).toBe(
        stringWidth(plainLine.slice(0, plainSeparatorIndex)),
      );
    } finally {
      session.close();
    }
  });

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

  test("real PTY sessions can expand and collapse unchanged context", async () => {
    const fixture = harness.createExpandableContextFilePair();
    const session = await harness.launchHunk({
      args: ["diff", fixture.before, fixture.after, "--mode", "split"],
      cols: 140,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Theme\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("▾ 1 unchanged line");
      expect(initial).not.toContain("hiddenLine01");

      await session.press("z");
      const expanded = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Hide 1 unchanged line") && text.includes("hiddenLine01"),
        5_000,
      );

      expect(expanded).toContain("hiddenLine01");

      await session.press("z");
      const collapsed = await harness.waitForSnapshot(
        session,
        (text) => text.includes("▾ 1 unchanged line") && !text.includes("hiddenLine01"),
        5_000,
      );

      expect(collapsed).not.toContain("hiddenLine01");
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
});
