import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  detectTerminalThemeModeFromBackground,
  parseOsc11BackgroundColor,
  themeModeForBackgroundColor,
} from "./themeDetection";

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

  test("detects terminal mode from the queried input stream", async () => {
    const input = new FakeThemeInput();
    let query = "";
    const output = {
      write(chunk: string) {
        query += chunk;
        queueMicrotask(() => input.emit("data", "\x1b]11;rgb:0000/0000/0000\x1b\\"));
      },
    };

    await expect(
      detectTerminalThemeModeFromBackground({ input, output, timeoutMs: 50 }),
    ).resolves.toBe("dark");
    expect(query).toBe("\x1b]11;?\x1b\\");
    expect(input.isRaw).toBe(false);
  });
});
