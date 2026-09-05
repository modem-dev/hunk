import { describe, expect, test } from "bun:test";
import {
  hasTerminalHandoff,
  parseTerminalHandoffMessage,
  terminalHandoffEnv,
  terminalHandoffMessage,
  terminalHandoffThemeMode,
} from "./terminalHandoff";

describe("terminal handoff protocol", () => {
  test("uses a private marker and inherits only a valid terminal mode", () => {
    const env = terminalHandoffEnv({ PATH: "/bin" }, "dark");
    expect(hasTerminalHandoff(env)).toBe(true);
    expect(terminalHandoffThemeMode(env)).toBe("dark");
    expect(
      terminalHandoffThemeMode({
        HUNK_TERMINAL_HANDOFF: "1",
        HUNK_TERMINAL_HANDOFF_THEME_MODE: "blue",
      }),
    ).toBeUndefined();
    expect(terminalHandoffThemeMode({ HUNK_TERMINAL_HANDOFF_THEME_MODE: "light" })).toBeUndefined();
  });

  test("accepts only versioned bounded messages", () => {
    expect(parseTerminalHandoffMessage(terminalHandoffMessage("ready"))).toEqual({
      protocol: "hunk-terminal-handoff-v1",
      kind: "ready",
    });
    expect(parseTerminalHandoffMessage({ protocol: "wrong", kind: "ready" })).toBeUndefined();
    expect(
      parseTerminalHandoffMessage({ protocol: "hunk-terminal-handoff-v1", kind: "other" }),
    ).toBeUndefined();
    expect(
      parseTerminalHandoffMessage({
        protocol: "hunk-terminal-handoff-v1",
        kind: "failed",
        message: "x".repeat(3_000),
      }),
    ).toEqual({
      protocol: "hunk-terminal-handoff-v1",
      kind: "failed",
      message: "x".repeat(2_000),
    });
  });
});
