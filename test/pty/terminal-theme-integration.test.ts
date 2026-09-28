import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Session } from "tuistory";
import { createPtyHarness, sleep } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(30_000);

afterEach(() => {
  harness.cleanup();
});

interface TestTerminalPalette {
  foreground: string;
  background: string;
  ansi: readonly string[];
}

const PALETTE_A: TestTerminalPalette = {
  foreground: "#f0f0f0",
  background: "#101010",
  ansi: [
    "#101010",
    "#ff4040",
    "#40ff40",
    "#ffff40",
    "#4080ff",
    "#ff40ff",
    "#40ffff",
    "#f0f0f0",
    "#808080",
    "#ff7070",
    "#70ff70",
    "#ffff70",
    "#70a0ff",
    "#ff70ff",
    "#70ffff",
    "#ffffff",
  ],
};

const PALETTE_B: TestTerminalPalette = {
  foreground: "#e8e8e8",
  background: "#202020",
  ansi: [
    "#202020",
    "#dd3355",
    "#00aa55",
    "#ccaa33",
    "#55aaff",
    "#aa66ff",
    "#33bbbb",
    "#e8e8e8",
    "#777777",
    "#ff6688",
    "#33cc77",
    "#ddbb55",
    "#77bbff",
    "#bb88ff",
    "#55dddd",
    "#ffffff",
  ],
};

const TERMINAL_QUERY_PATTERN = /\x1b\](?:4;(\d+)|(\d+));\?(?:\x07|\x1b\\)|\x1b\[c/g;
// OpenTUI's startup capability window, during which Hunk's live probes skip their DA1 fence.
const STARTUP_CAPABILITY_WINDOW_MS = 5_000;

/**
 * Answer Hunk and OpenTUI color queries from a mutable terminal palette, like a terminal that
 * answers OSC 10/11/12 and OSC 4 but not OSC 13-19. Replies keep query order even when delayed,
 * and each reply uses the palette current when its query arrived.
 */
function createTestTerminalResponder(initialPalette: TestTerminalPalette) {
  let palette = initialPalette;
  let buffer = "";
  let pending = Promise.resolve();
  const state = { replyDelayMs: 0, paletteRepliesSent: 0 };

  return {
    state,
    setPalette(nextPalette: TestTerminalPalette) {
      palette = nextPalette;
    },
    respond(data: string, session: Session) {
      buffer += data;
      TERMINAL_QUERY_PATTERN.lastIndex = 0;
      let consumedThrough = 0;
      let response = "";
      let match: RegExpExecArray | null;

      while ((match = TERMINAL_QUERY_PATTERN.exec(buffer))) {
        consumedThrough = TERMINAL_QUERY_PATTERN.lastIndex;
        const paletteIndex = match[1] === undefined ? undefined : Number(match[1]);
        const specialIndex = match[2] === undefined ? undefined : Number(match[2]);
        if (paletteIndex !== undefined) {
          const color = palette.ansi[paletteIndex];
          if (color) response += `\x1b]4;${paletteIndex};${color}\x07`;
        } else if (specialIndex !== undefined) {
          if (specialIndex > 12) continue;
          const color = specialIndex === 11 ? palette.background : palette.foreground;
          response += `\x1b]${specialIndex};${color}\x07`;
        } else {
          response += "\x1b[?62;22c";
        }
      }

      buffer = buffer.slice(consumedThrough).slice(-64);
      if (!response) return;
      const delayMs = state.replyDelayMs;
      const send = () => {
        session.writeRaw(response);
        if (response.includes("\x1b]4;")) state.paletteRepliesSent += 1;
      };
      pending = pending.then(() => (delayMs > 0 ? sleep(delayMs).then(send) : send()));
    },
  };
}

/** Wait until one exact foreground color paints the expected terminal text. */
async function waitForForeground(session: Session, color: string, needle: string) {
  const deadline = Date.now() + 10_000;
  let coloredText = "";
  while (Date.now() < deadline) {
    coloredText = await session.text({ immediate: true, only: { foreground: color } });
    if (coloredText.includes(needle)) return coloredText;
    await session.waitIdle({ timeout: 100 });
    await sleep(25);
  }

  throw new Error(
    `Timed out waiting for ${JSON.stringify(needle)} in foreground ${color}. Last colored text:\n${coloredText}`,
  );
}

/** Wait until a condition over the responder's state holds. */
async function waitForResponder(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the terminal responder.");
    await sleep(5);
  }
}

/** Assert that palette A no longer paints the review and palette B fully does. */
async function expectOnlyPaletteB(session: Session, needles: { keyword: string; text: string }) {
  expect(await waitForForeground(session, PALETTE_B.ansi[5]!, needles.keyword)).toContain(
    needles.keyword,
  );
  expect(await waitForForeground(session, PALETTE_B.foreground, needles.text)).toContain(
    needles.text,
  );
  // Let any in-flight probe finish before checking nothing reverted or kept the old palette.
  await sleep(400);
  expect(
    await session.text({ immediate: true, only: { foreground: PALETTE_A.ansi[5]! } }),
  ).not.toContain(needles.keyword);
  expect(
    await session.text({ immediate: true, only: { foreground: PALETTE_B.ansi[5]! } }),
  ).toContain(needles.keyword);
}

/** Launch `hunk diff` on the agent file pair with a TTY stdin. */
async function launchTestDiffSession(terminal: ReturnType<typeof createTestTerminalResponder>) {
  const fixture = harness.createAgentFilePair();
  const session = await harness.launchHunk({
    args: ["diff", "--files", fixture.before, fixture.after, "--mode", "unified"],
    cwd: fixture.dir,
    cols: 100,
    rows: 24,
    testTerminalResponder: terminal.respond,
  });
  await session.waitForText("export const answer = 42;");
  await waitForForeground(session, PALETTE_A.ansi[5]!, "export");
  await waitForForeground(session, PALETTE_A.foreground, "answer");
  return session;
}

const DIFF_NEEDLES = { keyword: "export", text: "answer" };

describe("PTY terminal theme", () => {
  test("repaints from a fresh terminal palette after a dark-to-dark color-scheme notification", async () => {
    const terminal = createTestTerminalResponder(PALETTE_A);
    const session = await launchTestDiffSession(terminal);

    try {
      terminal.setPalette(PALETTE_B);
      session.writeRaw("\x1b[?997;1n");
      await expectOnlyPaletteB(session, DIFF_NEEDLES);
    } finally {
      session.close();
    }
  });

  test("repaints a piped `patch -` review after a color-scheme notification", async () => {
    const fixture = harness.createPagerPatchFixture(8);
    const terminal = createTestTerminalResponder(PALETTE_A);
    const session = await harness.launchShellCommand({
      command: `cat ${harness.shellQuote(fixture.patchFile)} | exec ${harness.buildHunkCommand([
        "patch",
        "-",
        "--mode",
        "unified",
      ])}`,
      cwd: fixture.dir,
      cols: 100,
      rows: 24,
      testTerminalResponder: terminal.respond,
    });
    const needles = { keyword: "export", text: "after_01" };

    try {
      await session.waitForText("after_01");
      await waitForForeground(session, PALETTE_A.ansi[5]!, needles.keyword);
      await waitForForeground(session, PALETTE_A.foreground, needles.text);

      terminal.setPalette(PALETTE_B);
      session.writeRaw("\x1b[?997;1n");
      await expectOnlyPaletteB(session, needles);
    } finally {
      session.close();
    }
  });

  test("ends on the new palette when a stale notification races the real switch", async () => {
    const terminal = createTestTerminalResponder(PALETTE_A);
    const session = await launchTestDiffSession(terminal);

    try {
      // The terminal announces the switch before its palette changes, so the first probe is
      // answered slowly with the old colors; only then does it switch and notify again.
      terminal.state.replyDelayMs = 100;
      const answeredBefore = terminal.state.paletteRepliesSent;
      session.writeRaw("\x1b[?997;1n");
      await waitForResponder(() => terminal.state.paletteRepliesSent > answeredBefore);
      terminal.setPalette(PALETTE_B);
      terminal.state.replyDelayMs = 0;
      session.writeRaw("\x1b[?997;1n");

      await expectOnlyPaletteB(session, DIFF_NEEDLES);
    } finally {
      session.close();
    }
  });

  test("picks up a switch from a terminal that answers slowly once DA1 fences are active", async () => {
    const terminal = createTestTerminalResponder(PALETTE_A);
    const session = await launchTestDiffSession(terminal);

    try {
      await sleep(STARTUP_CAPABILITY_WINDOW_MS);
      terminal.state.replyDelayMs = 400;
      terminal.setPalette(PALETTE_B);
      session.writeRaw("\x1b[?997;1n");

      await expectOnlyPaletteB(session, DIFF_NEEDLES);
      // Neither the replies nor the consumed DA1 fence reach the screen.
      expect(await session.text({ immediate: true })).not.toMatch(/62;22c|rgb:|\]4;/);
    } finally {
      session.close();
    }
  });
});
