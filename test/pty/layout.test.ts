import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import stringWidth from "string-width";
import { createPtyHarness, dragMouse, rightmostColumnOf, sleep } from "./harness";

const harness = createPtyHarness();

/** Give PTY-backed startup and redraws enough headroom for slower CI machines. */
setDefaultTimeout(20_000);

afterEach(() => {
  harness.cleanup();
});

/** Locate the left pane divider from a rendered terminal frame. */
function sidebarDividerColumn(frame: string) {
  const columns = frame
    .split("\n")
    .map((line) => line.indexOf("│"))
    .filter((column) => column >= 0);
  return columns.length === 0 ? -1 : Math.min(...columns);
}

/** Return the rendered columns owned by the left sidebar. */
function sidebarFrame(frame: string) {
  const divider = sidebarDividerColumn(frame);
  return frame
    .split("\n")
    .map((line) => line.slice(0, divider))
    .join("\n");
}

describe("PTY layout", () => {
  test("the first frame fills the viewport bottom with the next file section", async () => {
    // The first review frame must fill the whole viewport: when the leading file overflows just
    // enough, the start of the next file has to render at the bottom without any scroll input.
    // Locks in the user-visible contract — a multi-file first paint fills to the bottom edge.
    const fixture = harness.createPinnedHeaderRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 120,
      rows: 28,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      // first.ts overflows just enough that second.ts must peek at the bottom of the first frame.
      const firstFrame = await harness.waitForSnapshot(
        session,
        (text) => text.includes("second.ts") && text.includes("line17 = 117"),
        8_000,
      );

      expect(firstFrame).toContain("second.ts");
      expect(firstFrame).toContain("line17 = 117");
    } finally {
      session.close();
    }
  });

  test("the first nowrap frame fills a tall viewport past the first-file overscan neighbor", async () => {
    // File windowing with a still-unmeasured (0) viewport only mounts the leading file plus one
    // overscan neighbor. A tall first paint must use the estimated height so later short files
    // appear without any scroll input.
    const fixture = harness.createManyShortFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack", "--no-sidebar"],
      cwd: fixture.dir,
      cols: 100,
      rows: 40,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      const firstFrame = await harness.waitForSnapshot(
        session,
        (text) => text.includes("short-3.ts") && text.includes("short3 = 13"),
        8_000,
      );

      expect(firstFrame).toContain("short-3.ts");
      expect(firstFrame).toContain("short3 = 13");
    } finally {
      session.close();
    }
  });

  test("a larger file gap inserts blank rows before the next file header", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "stack", "--no-sidebar", "--file-gap", "3"],
      cwd: fixture.dir,
      cols: 100,
      rows: 24,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      const snapshot = await harness.waitForSnapshot(
        session,
        (text) => text.includes("alpha.ts") && text.includes("beta.ts"),
        8_000,
      );
      const lines = snapshot.split("\n");
      const betaIndex = lines.findIndex((line) => line.includes("beta.ts"));
      expect(betaIndex).toBeGreaterThan(2);
      const preceding = lines.slice(betaIndex - 3, betaIndex);
      expect(preceding).toHaveLength(3);
      expect(preceding[0]?.trim()).toBe("");
      expect(preceding[1]?.trim()).toBe("");
      expect(preceding[2]).toContain("─");
    } finally {
      session.close();
    }
  });

  test("a hunk gap inserts blank rows before the next hunk header", async () => {
    const fixture = harness.createMultiHunkFilePair();
    const session = await harness.launchHunk({
      args: [
        "diff",
        "--files",
        fixture.before,
        fixture.after,
        "--mode",
        "stack",
        "--no-sidebar",
        "--hunk-gap",
        "2",
      ],
      cols: 100,
      rows: 32,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      const snapshot = await harness.waitForSnapshot(
        session,
        (text) => (text.match(/@@/g) ?? []).length >= 2,
        8_000,
      );
      const lines = snapshot.split("\n");
      const headerIndexes = lines.flatMap((line, index) => (line.includes("@@") ? [index] : []));
      expect(headerIndexes.length).toBeGreaterThanOrEqual(2);
      const secondHeader = headerIndexes[1]!;
      expect(lines[secondHeader - 2]?.trim()).toBe("");
      expect(lines[secondHeader - 1]?.trim()).toBe("");
    } finally {
      session.close();
    }
  });

  test("split rows keep the center separator aligned after wide characters", async () => {
    const fixture = harness.createWideCharacterFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 140,
      rows: 16,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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

  test("renamed CJK and emoji paths render as Unicode in the sidebar and file header", async () => {
    const fixture = harness.createUnicodePathRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--staged", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 16,
    });

    try {
      const snapshot = await session.waitForText(/한국어-🧪\.txt/, {
        timeout: 15_000,
      });

      expect(snapshot).toContain("国際化/");
      expect(snapshot).toContain("日本語.txt");
      expect(snapshot).toContain("한국어-🧪.txt");
      expect(snapshot).not.toContain("\\345\\233\\275");
    } finally {
      session.close();
    }
  });

  test("the CLI tab width reaches interactive app rendering", async () => {
    const fixture = harness.createTabbedFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "stack", "-x8"],
      cols: 100,
      rows: 12,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      const snapshot = await harness.waitForSnapshot(
        session,
        (text) => /a {7}after/.test(text),
        5_000,
      );
      const addedLine = snapshot.split("\n").find((line) => /a {7}after/.test(line));

      expect(addedLine).toMatch(/a {7}after/);
    } finally {
      session.close();
    }
  });

  test("real PTY sessions can toggle wrapped lines on and off", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 102,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 140,
      rows: 16,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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

  test("narrow terminals preserve stats and use three dots for truncated file paths", async () => {
    const fixture = harness.createNarrowHeaderTestRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "auto"],
      cwd: fixture.dir,
      cols: 40,
      rows: 12,
    });

    try {
      await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      const snapshot = await harness.waitForSnapshot(
        session,
        (text) => text.includes("packages/visual-studio-cod... +1 -1"),
        5_000,
      );

      expect(snapshot).not.toContain("packages/visual-studio-code-.");
    } finally {
      session.close();
    }
  });

  test("auto layout responds to live terminal resize in a real PTY", async () => {
    const fixture = harness.createNestedSidebarRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "auto"],
      cwd: fixture.dir,
      cols: 220,
      rows: 24,
    });

    try {
      const wide = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(harness.countMatches(wide, /alpha\.ts/g)).toBeGreaterThanOrEqual(2);
      expect(sidebarFrame(wide)).not.toContain("src/ui/");
      expect(wide).toMatch(/▌.*▌/);

      session.resize({ cols: 180, rows: 24 });
      const medium = await harness.waitForSnapshot(
        session,
        (text) => sidebarFrame(text).includes("src/ui/"),
        5_000,
      );
      expect(harness.countMatches(medium, /alpha\.ts/g)).toBeGreaterThanOrEqual(2);
      expect(medium).toMatch(/▌.*▌/);

      session.resize({ cols: 150, rows: 24 });
      const narrow = await harness.waitForSnapshot(
        session,
        (text) => harness.countMatches(text, /alpha\.ts/g) === 1 && /▌.*▌/.test(text),
        5_000,
      );
      expect(narrow).toMatch(/▌.*▌/);

      session.resize({ cols: 110, rows: 24 });
      const tight = await harness.waitForSnapshot(session, (text) => !/▌.*▌/.test(text), 5_000);
      expect(harness.countMatches(tight, /alpha\.ts/g)).toBe(1);
      expect(tight).not.toMatch(/▌.*▌/);
    } finally {
      session.close();
    }
  });

  test("--sidebar shows the sidebar below the automatic sidebar cutoff", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split", "--sidebar"],
      cwd: fixture.dir,
      cols: 150,
      rows: 18,
    });

    try {
      const frame = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(harness.countMatches(frame, /alpha\.ts/g)).toBeGreaterThanOrEqual(2);
    } finally {
      session.close();
    }
  });

  test("--no-sidebar opens the review with the sidebar closed", async () => {
    const fixture = harness.createTwoFileRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split", "--no-sidebar"],
      cwd: fixture.dir,
      cols: 220,
      rows: 18,
    });

    try {
      const frame = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(harness.countMatches(frame, /alpha\.ts/g)).toBe(1);

      await session.type("s");
      const toggled = await harness.waitForSnapshot(
        session,
        (text) => harness.countMatches(text, /alpha\.ts/g) >= 2,
        5_000,
      );

      expect(harness.countMatches(toggled, /alpha\.ts/g)).toBeGreaterThanOrEqual(2);
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
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      const initialMainColumn = rightmostColumnOf(initial, "alpha.ts");
      const initialDividerColumn = sidebarDividerColumn(initial);

      expect(initialDividerColumn).toBeGreaterThan(0);
      expect(initialMainColumn).toBeGreaterThan(initialDividerColumn);

      await dragMouse(session, initialDividerColumn - 2, 6, initialDividerColumn + 18, 6);
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

  test("retains a sidebar drag when its first motion switches the file projection", async () => {
    const fixture = harness.createNestedSidebarRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 18,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      const initialMainColumn = rightmostColumnOf(initial, "alpha.ts");
      const initialDividerColumn = sidebarDividerColumn(initial);
      const pressColumn = initialDividerColumn - 2;
      const projectionSwitchColumn = initialDividerColumn - 4;

      // Press the left edge of the five-cell hit target. The first motion crosses the tree
      // threshold and switches that row out before the second motion arrives.
      session.writeRaw(`\x1b[<0;${pressColumn + 1};7M`);
      await sleep(20);
      session.writeRaw(`\x1b[<32;${projectionSwitchColumn + 1};7M`);
      await harness.waitForSnapshot(
        session,
        (text) =>
          text
            .split("\n")
            .map((line) => line.slice(0, initialDividerColumn - 2))
            .join("\n")
            .includes("src/ui/"),
        5_000,
      );
      const finalColumn = initialDividerColumn - 16;
      session.writeRaw(`\x1b[<32;${finalColumn + 1};7M`);
      await sleep(20);
      session.writeRaw(`\x1b[<0;${finalColumn + 1};7m`);
      await session.waitIdle();

      const resized = await harness.waitForSnapshot(
        session,
        (text) => rightmostColumnOf(text, "alpha.ts") <= initialMainColumn - 8,
        5_000,
      );
      expect(rightmostColumnOf(resized, "alpha.ts")).toBeLessThanOrEqual(initialMainColumn - 8);
    } finally {
      session.close();
    }
  });

  test("dragging the sidebar through 31 content columns switches to compact paths", async () => {
    const fixture = harness.createNestedSidebarRepoFixture();
    const session = await harness.launchHunk({
      args: ["diff", "--mode", "split"],
      cwd: fixture.dir,
      cols: 220,
      rows: 18,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });
      const initialDividerColumn = sidebarDividerColumn(initial);
      const compactDividerColumn = initialDividerColumn - 2;
      const initialSidebar = initial
        .split("\n")
        .map((line) => line.slice(0, initialDividerColumn))
        .join("\n");

      expect(initialSidebar).not.toContain("src/ui/");
      expect(initialSidebar).toContain("src/");
      expect(initialSidebar).toContain("ui/");
      expect(
        initialSidebar
          .split("\n")
          .find((line) => line.includes("src/"))
          ?.indexOf("src/"),
      ).toBe(2);

      await dragMouse(session, initialDividerColumn - 2, 6, initialDividerColumn - 4, 6);
      const resized = await harness.waitForSnapshot(
        session,
        (text) =>
          text
            .split("\n")
            .map((line) => line.slice(0, compactDividerColumn))
            .join("\n")
            .includes("src/ui/"),
        5_000,
      );
      const resizedSidebar = resized
        .split("\n")
        .map((line) => line.slice(0, compactDividerColumn))
        .join("\n");

      expect(resizedSidebar).toContain("src/ui/");
      expect(
        resizedSidebar
          .split("\n")
          .find((line) => line.includes("src/ui/"))
          ?.indexOf("src/ui/"),
      ).toBe(2);
      expect(resizedSidebar).toContain("alpha.ts");
      expect(resizedSidebar).toContain("beta.ts");
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
      const wide = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(harness.countMatches(wide, /alpha\.ts/g)).toBeGreaterThanOrEqual(2);
      expect(wide).toMatch(/▌.*▌/);

      session.resize({ cols: 140, rows: 24 });
      const tight = await harness.waitForSnapshot(
        session,
        (text) =>
          /▌.*▌/.test(text) &&
          harness.countMatches(text, /alpha\.ts/g) === 1 &&
          text.includes("betaValue = 1"),
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
      const narrow = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 220,
      rows: 12,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
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
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 102,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("this is a very long");
      expect(initial).not.toContain("ge';");

      let shifted = initial;
      for (let index = 0; index < 96; index += 1) {
        await session.press("right");
        // press() already waits for idle, so read the settled frame immediately rather than
        // paying another render round-trip per column; the loop retries if a frame lags.
        shifted = await session.text({ immediate: true });
        if (shifted.includes("ge';")) {
          break;
        }
      }

      expect(shifted).toContain("ge';");
      expect(shifted).not.toContain("this is a very long");

      let restored = shifted;
      for (let index = 0; index < 96; index += 1) {
        await session.press("left");
        restored = await session.text({ immediate: true });
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

  test("shifted mouse-wheel input scrolls code horizontally in a real PTY", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 102,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("this is a very long");
      expect(initial).not.toContain("ge';");

      let shifted = initial;
      for (let index = 0; index < 96; index += 1) {
        // SGR button 69 is a wheel-down event with the Shift modifier.
        session.writeRaw("\x1b[<69;61;11M");
        await session.waitIdle();
        shifted = await session.text({ immediate: true });
        if (shifted.includes("ge';")) {
          break;
        }
      }

      expect(shifted).toContain("ge';");
      expect(shifted).not.toContain("this is a very long");
    } finally {
      session.close();
    }
  });

  test("wrap toggles reset horizontal code scrolling in a real PTY", async () => {
    const fixture = harness.createLongWrapFilePair();
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "split"],
      cols: 102,
      rows: 20,
    });

    try {
      const initial = await session.waitForText(/View\s+Navigate\s+Agent\s+Help/, {
        timeout: 15_000,
      });

      expect(initial).toContain("this is a very long");
      expect(initial).not.toContain("ge';");

      let shifted = initial;
      for (let index = 0; index < 96; index += 1) {
        await session.press("right");
        // press() already waits for idle; read immediately to avoid a redundant settle per column.
        shifted = await session.text({ immediate: true });
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

      expect(wrapped).toContain("this is a very lo");
      expect(wrapped).toContain("wrapped line");
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
