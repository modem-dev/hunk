import { describe, expect, test } from "bun:test";
import { EmulatedTerminalScreen, WatchTerminalSession, waitForTerminalCondition } from "./terminal";

const marker = { menu: "File  View" as const, requiredText: ["fixture-title", "standard dirty"] };

/** Feed test chunks and wait for the selected emulator to parse the final chunk. */
function feedTestScreen(
  screen: EmulatedTerminalScreen,
  chunks: Array<string | Uint8Array>,
): Promise<void> {
  return new Promise((resolve) => {
    chunks.forEach((chunk, index) => {
      screen.feed(
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        index === chunks.length - 1 ? resolve : undefined,
      );
    });
  });
}

describe("watch campaign terminal screen detection", () => {
  test("detects a marker from an ANSI alternate screen rather than raw substrings", async () => {
    const screen = new EmulatedTerminalScreen();
    try {
      await feedTestScreen(screen, [
        "raw File  View fixture-title standard dirty\r",
        "\x1b[?1049h\x1b[2J\x1b[H",
        "File  View  Navigate  Agent  Help",
        "\x1b[2;1Hfixture-title\x1b[3;1Hstandard dirty",
      ]);
      expect(screen.hasMarker(marker)).toBe(true);
      expect(screen.getText()).not.toContain("raw File  View");
    } finally {
      screen.close();
    }
  });

  test("emulates ConPTY rewrites through the cross-platform fallback", async () => {
    const screen = new EmulatedTerminalScreen({ forceFallback: true });
    try {
      await feedTestScreen(screen, [
        "\x1b[?1049h\x1b[2J\x1b[HFile  View  Navigate",
        "\x1b[2;1Hfixture-title\x1b[3;1Hstandard dirty",
      ]);
      expect(screen.parser).toBe("xterm-headless-fallback");
      expect(screen.hasMarker(marker)).toBe(true);
      await feedTestScreen(screen, ["\x1b[3;1Hatomic tracked write\x1b[K"]);
      expect(screen.getText()).toContain("atomic tracked write");
    } finally {
      screen.close();
    }
  });

  test("handles split UTF-8 and ConPTY-style cursor rewrite chunks", async () => {
    const screen = new EmulatedTerminalScreen();
    try {
      const title = Buffer.from("fixture-title — portable");
      await feedTestScreen(screen, [
        "\x1b[?1049h\x1b[2J\x1b[HFile  Vi",
        "ew  Navigate\x1b[2;1H",
        title.subarray(0, title.length - 2),
        title.subarray(title.length - 2),
        "\x1b[3;1Hstandard dirty",
      ]);
      expect(screen.hasMarker(marker)).toBe(true);
      await feedTestScreen(screen, ["\x1b[3;1Hordinary tracked write\x1b[K"]);
      expect(screen.getText()).toContain("ordinary tracked write");
    } finally {
      screen.close();
    }
  });

  test("requires the menu on the first visible row and every fixture marker", async () => {
    const screen = new EmulatedTerminalScreen();
    try {
      await feedTestScreen(screen, [
        "\x1b[?1049h\x1b[2J\x1b[Hfixture-title\x1b[2;1HFile  View\x1b[3;1Hstandard dirty",
      ]);
      expect(screen.hasMarker(marker)).toBe(false);
    } finally {
      screen.close();
    }
  });

  test("cleans timeout subscriptions with an injected clock", async () => {
    let timeoutCallback = () => {};
    let unsubscribed = false;
    const waiting = waitForTerminalCondition({
      subscribe: () => () => {
        unsubscribed = true;
      },
      condition: () => false,
      processExited: () => false,
      timeoutMs: 10,
      timeoutMessage: "timed out",
      clock: {
        now: () => 0,
        setTimeout(callback) {
          timeoutCallback = callback;
          return 1;
        },
        clearTimeout: () => {},
      },
    });
    timeoutCallback();
    await expect(waiting).rejects.toThrow("timed out");
    expect(unsubscribed).toBe(true);
  });

  test("quits before closing the terminal handle", async () => {
    let resolveExit = (_code: number) => {};
    const process = {
      exitCode: null as number | null,
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
      kill() {
        this.exitCode = 1;
        resolveExit(1);
      },
    };
    const events: string[] = [];
    const terminal = {
      closed: false,
      write() {
        events.push("write-q");
        process.exitCode = 0;
        resolveExit(0);
        return 1;
      },
      close() {
        events.push("close-terminal");
        this.closed = true;
      },
    };
    const screen = new EmulatedTerminalScreen();
    const session = new WatchTerminalSession(
      process as unknown as Bun.Subprocess,
      terminal as unknown as Bun.Terminal,
      screen,
      { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} },
    );
    expect(await session.cleanup()).toBe(true);
    expect(events).toEqual(["write-q", "close-terminal"]);
  });
});
