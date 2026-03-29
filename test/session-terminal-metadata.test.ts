import { describe, expect, test } from "bun:test";
import { resolveSessionTerminalMetadata } from "../src/mcp/sessionTerminalMetadata";

describe("session terminal metadata", () => {
  test("captures tty, tmux, and iTerm2 identifiers in one generic structure", () => {
    const terminal = resolveSessionTerminalMetadata({
      env: {
        TERM_PROGRAM: "tmux",
        LC_TERMINAL: "iTerm2",
        ITERM_SESSION_ID: "w1t2p3:ABCDEF",
        TMUX_PANE: "%7",
      },
      tty: "/dev/ttys003",
    });

    expect(terminal).toEqual({
      program: "iTerm2",
      locations: [
        { source: "tty", tty: "/dev/ttys003" },
        { source: "tmux", paneId: "%7" },
        {
          source: "iterm2",
          windowId: "1",
          tabId: "2",
          paneId: "3",
          sessionId: "w1t2p3:ABCDEF",
        },
      ],
    });
  });

  test("keeps terminal program metadata even when no window or pane ids are available", () => {
    const terminal = resolveSessionTerminalMetadata({
      env: {
        TERM_PROGRAM: "ghostty",
      },
      tty: "/dev/pts/4",
    });

    expect(terminal).toEqual({
      program: "ghostty",
      locations: [{ source: "tty", tty: "/dev/pts/4" }],
    });
  });

  test("returns undefined when no terminal metadata is available", () => {
    expect(resolveSessionTerminalMetadata({ env: {}, tty: undefined })).toBeUndefined();
  });
});
