import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  detectTerminalColors,
  parseOsc11BackgroundColor,
  parseTerminalColorReplies,
  themeModeForBackgroundColor,
  themeModeForTerminalColors,
} from "./detection";

class FakeThemeInput extends EventEmitter {
  isRaw = false;
  setRawMode(mode: boolean) {
    this.isRaw = mode;
  }
  resume() {}
}

/** Unit coverage for the terminal background probe used by auto theme POC. */
describe("terminal theme detection", () => {
  test("parses OSC 11 rgb responses", () => {
    expect(parseOsc11BackgroundColor("\x1b]11;rgb:0000/1111/2222\x1b\\")).toEqual({
      red: 0,
      green: 17,
      blue: 34,
    });
    expect(parseOsc11BackgroundColor("\x1b]11;#ffffff\x07")).toEqual({
      red: 255,
      green: 255,
      blue: 255,
    });
  });

  test("classifies dark and light backgrounds", () => {
    expect(themeModeForBackgroundColor({ red: 12, green: 12, blue: 12 })).toBe("dark");
    expect(themeModeForBackgroundColor({ red: 245, green: 245, blue: 245 })).toBe("light");
  });

  test("parses OSC 4, 10, and 11 replies into hex terminal colors", () => {
    expect(
      parseTerminalColorReplies(
        "\x1b]10;rgb:ffff/ffff/ffff\x1b\\" +
          "\x1b]11;rgb:1a1a/1b1b/2626\x07" +
          "\x1b]4;1;rgb:f7/76/8e\x1b\\" +
          "\x1b]4;2;#9ece6a\x07" +
          "\x1b]4;99;rgb:0000/0000/0000\x1b\\",
      ),
    ).toEqual({
      foreground: "#ffffff",
      background: "#1a1b26",
      palette: [undefined, "#f7768e", "#9ece6a"],
    });
  });

  test("detects terminal colors from the queried input stream and stops at device attributes", async () => {
    const input = new FakeThemeInput();
    let query = "";
    const output = {
      write(chunk: string) {
        query += chunk;
        queueMicrotask(() =>
          input.emit(
            "data",
            "\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\" +
              "\x1b]4;4;rgb:0000/0000/ffff\x1b\\\x1b[?62;22c",
          ),
        );
      },
    };

    const colors = await detectTerminalColors({ input, output, timeoutMs: 5_000 });
    expect(colors).toEqual({
      foreground: "#ffffff",
      background: "#000000",
      palette: [undefined, undefined, undefined, undefined, "#0000ff"],
    });
    expect(themeModeForTerminalColors(colors)).toBe("dark");
    expect(query).toStartWith("\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]4;0;?\x1b\\");
    expect(query).toEndWith("\x1b]4;15;?\x1b\\\x1b[c");
    expect(input.isRaw).toBe(false);
  });

  test("returns null when the terminal answers no color queries", async () => {
    const input = new FakeThemeInput();
    const output = { write: () => queueMicrotask(() => input.emit("data", "\x1b[?1;2c")) };

    await expect(detectTerminalColors({ input, output, timeoutMs: 5_000 })).resolves.toBeNull();
  });
});
