import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Session } from "tuistory";
import { createPtyHarness, sleep } from "./harness";

const harness = createPtyHarness();

setDefaultTimeout(20_000);

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

/** Answer Hunk and OpenTUI color queries from a mutable terminal palette. */
function createTestTerminalResponder(initialPalette: TestTerminalPalette) {
  let palette = initialPalette;
  let buffer = "";

  return {
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
          const color = specialIndex === 11 ? palette.background : palette.foreground;
          response += `\x1b]${specialIndex};${color}\x07`;
        } else {
          response += "\x1b[?62;22c";
        }
      }

      buffer = buffer.slice(consumedThrough).slice(-64);
      if (response) session.writeRaw(response);
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

describe("PTY terminal theme", () => {
  test("repaints from a fresh terminal palette after a dark-to-dark color-scheme notification", async () => {
    const fixture = harness.createAgentFilePair();
    const terminal = createTestTerminalResponder(PALETTE_A);
    const session = await harness.launchHunk({
      args: ["diff", "--files", fixture.before, fixture.after, "--mode", "unified"],
      cwd: fixture.dir,
      cols: 100,
      rows: 24,
      testTerminalResponder: terminal.respond,
    });

    try {
      await session.waitForText("export const answer = 42;");
      expect(await waitForForeground(session, PALETTE_A.ansi[5]!, "export")).toContain("const");
      expect(await waitForForeground(session, PALETTE_A.foreground, "answer")).toContain("added");

      terminal.setPalette(PALETTE_B);
      session.writeRaw("\x1b[?997;1n");

      expect(await waitForForeground(session, PALETTE_B.ansi[5]!, "export")).toContain("const");
      expect(await waitForForeground(session, PALETTE_B.foreground, "answer")).toContain("added");
      expect(
        await session.text({ immediate: true, only: { foreground: PALETTE_A.ansi[5]! } }),
      ).not.toContain("export");
    } finally {
      session.close();
    }
  });
});
