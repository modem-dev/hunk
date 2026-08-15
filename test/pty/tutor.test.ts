import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "tuistory";
import { createPtyHarness } from "./harness";

const harness = createPtyHarness();

/** Give the compiled-style startup and OpenTUI redraw loop room on slower CI workers. */
setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

/** Find the terminal-native color run that paints one visible tutor phrase. */
function findRenderedSpan(session: Session, phrase: string) {
  return session
    .getTerminalData()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes(phrase));
}

describe("PTY tutor", () => {
  test("teaches the live keymap and advances one instructional step at a time", async () => {
    const configHome = harness.createIsolatedConfigHome();
    mkdirSync(join(configHome, "hunk"), { recursive: true });
    writeFileSync(
      join(configHome, "hunk", "config.toml"),
      '[keybindings]\n"hunk.review.stepDown" = "ctrl+n"\n',
    );

    const session = await harness.launchHunk({
      args: ["tutor", "--mode", "stack"],
      cols: 180,
      rows: 30,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      await session.waitForData({ timeout: 20_000 });
      const welcome = await harness.waitForSnapshot(
        session,
        (text) => text.includes("Welcome to Hunk Tutor") && text.includes("start lesson 1"),
        20_000,
      );
      expect(welcome).toContain("The diff itself is the guide");
      await session.press("enter");
      await harness.ensureKeyboardIsLive(session);
      const initial = await harness.waitForSnapshot(
        session,
        (text) =>
          text.includes("HUNK TUTOR") && text.includes("NEXT STEP") && text.includes("1/36"),
        20_000,
      );
      expect(initial).toContain("1/36");
      expect(initial).toContain("ctrl+n");
      expect(initial).toContain("Extensions");
      expect(initial).toContain("Hunk Tutor");

      session.sendKey(["ctrl", "n"]);
      await Bun.sleep(200);
      const moved = await session.text({ immediate: true });
      expect(moved).toContain("2/36");
      expect(moved).toContain("move up one row");

      const lessonOneKeys: Array<Parameters<typeof session.press>[0]> = [
        "up",
        "]",
        "[",
        ".",
        ",",
        "g",
        ["shift", "g"],
      ];
      for (const key of lessonOneKeys) {
        await session.press(key);
        await Bun.sleep(120);
      }
      await session.waitForText(/02 · Cover distance/, { timeout: 5_000 });
      const lessonTwo = await harness.waitForSnapshot(
        session,
        (text) => text.includes("PAGE CHECKPOINT"),
        5_000,
      );
      const checkpointRow = lessonTwo
        .split("\n")
        .findIndex((line) => line.includes("PAGE CHECKPOINT — page-down works"));
      expect(checkpointRow).toBeGreaterThan(0);
      expect(checkpointRow).toBeLessThan(20);
      expect(findRenderedSpan(session, "PAGE CHECKPOINT")?.bg).toBeDefined();

      const distanceKeys: Array<Parameters<typeof session.press>[0]> = ["space", "b", "d", "u"];
      for (const key of distanceKeys) {
        await session.press(key);
        await Bun.sleep(120);
      }
      const panRight = await session.waitForText(/pan right across the wide line/i, {
        timeout: 5_000,
      });
      expect(panRight).toContain("13/36");

      await session.press("right");
      const panLeft = await session.waitForText(/pan left toward/i, {
        timeout: 5_000,
      });
      expect(panLeft).toContain("14/36");

      await session.press("left");
      const context = await session.waitForText(/expand the folded explanation/i, {
        timeout: 5_000,
      });
      expect(context).toContain("15/36");

      await session.press(["ctrl", "g"]);
      const finish = await session.waitForText(/Finish Hunk Tutor\?/, {
        timeout: 5_000,
      });
      expect(finish).toContain("hunk tutor");
      expect(finish).not.toContain("ext hunk-tutor");
    } finally {
      session.close();
    }
  });

  test("keeps a drafted note readable in the focused 80-column layout", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const session = await harness.launchHunk({
      args: ["tutor", "--mode", "stack"],
      cols: 80,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("Welcome to Hunk Tutor") && text.includes("start lesson 1"),
        20_000,
      );
      await session.press("enter");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("HUNK TUTOR") && text.includes("NEXT STEP"),
        20_000,
      );

      await session.press("c");
      const draft = await session.waitForText(/Draft note/, { timeout: 5_000 });
      expect(draft).toContain("Write a note");

      await session.type("Reserve math deserves a test.");
      await session.waitForText(/Reserve math deserves a test\./, { timeout: 5_000 });
      await session.press(["ctrl", "s"]);

      const saved = await session.waitForText(/Your note/, { timeout: 5_000 });
      expect(saved).toContain("Reserve math deserves a test.");
    } finally {
      session.close();
    }
  });

  test("keeps the last payoff visible beside the next spotlight at 80 columns", async () => {
    const configHome = harness.createIsolatedConfigHome();
    const session = await harness.launchHunk({
      args: ["tutor", "--mode", "stack"],
      cols: 80,
      rows: 24,
      env: { XDG_CONFIG_HOME: configHome },
    });

    try {
      await session.waitForText(/Welcome to Hunk Tutor/, { timeout: 20_000 });
      await session.press("enter");
      await harness.waitForSnapshot(
        session,
        (text) => text.includes("NEXT STEP") && text.includes("controls help"),
        20_000,
      );

      const firstSpotlight = findRenderedSpan(session, "controls help");
      expect(firstSpotlight?.bg).toBeDefined();
      expect(firstSpotlight?.fg).toBeDefined();

      await session.press("?");
      await session.waitForText(/Controls help/, { timeout: 5_000 });
      await session.press("escape");
      await session.waitForText(/move down one row/, { timeout: 5_000 });

      const completedPayoff = findRenderedSpan(session, "controls help");
      const nextSpotlight = findRenderedSpan(session, "Move down once");
      expect(completedPayoff?.bg).toBeDefined();
      expect(nextSpotlight?.bg).toBeDefined();
      expect(completedPayoff?.bg).not.toBe(nextSpotlight?.bg);
      expect(nextSpotlight?.fg).not.toBe(completedPayoff?.fg);
    } finally {
      session.close();
    }
  });
});
