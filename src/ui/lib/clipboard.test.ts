import { describe, expect, mock, test } from "bun:test";
import { copyTextToClipboard, type TerminalClipboard } from "./clipboard";

describe("clipboard helpers", () => {
  test("uses pbcopy first on macOS", () => {
    const terminal: TerminalClipboard = {
      copyToClipboardOSC52: mock(() => true),
    };
    const spawnSync = mock(() => ({ status: 0 }));

    expect(copyTextToClipboard("selected text", terminal, { platform: "darwin", spawnSync })).toBe(
      true,
    );
    expect(spawnSync).toHaveBeenCalledWith("pbcopy", [], {
      input: "selected text",
      stdio: ["pipe", "ignore", "ignore"],
    });
    expect(terminal.copyToClipboardOSC52).not.toHaveBeenCalled();
  });

  test("falls back to OSC 52 when macOS pbcopy is unavailable", () => {
    const terminal: TerminalClipboard = {
      copyToClipboardOSC52: mock(() => true),
    };
    const spawnSync = mock(() => ({ status: 1 }));

    expect(copyTextToClipboard("selected text", terminal, { platform: "darwin", spawnSync })).toBe(
      true,
    );
    expect(terminal.copyToClipboardOSC52).toHaveBeenCalledWith("selected text");
  });

  test("uses OSC 52 on non-macOS terminals", () => {
    const terminal: TerminalClipboard = {
      copyToClipboardOSC52: mock(() => true),
    };
    const spawnSync = mock(() => ({ status: 0 }));

    expect(copyTextToClipboard("selected text", terminal, { platform: "linux", spawnSync })).toBe(
      true,
    );
    expect(terminal.copyToClipboardOSC52).toHaveBeenCalledWith("selected text");
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test("returns false when no clipboard path is available", () => {
    const terminal: TerminalClipboard = {
      copyToClipboardOSC52: mock(() => false),
    };
    const spawnSync = mock(() => ({ status: 0 }));

    expect(copyTextToClipboard("selected text", terminal, { platform: "linux", spawnSync })).toBe(
      false,
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
