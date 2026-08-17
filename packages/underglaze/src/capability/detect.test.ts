import { describe, expect, test } from "bun:test";
import {
  detectMultiplexer,
  wrapForMultiplexer,
  wrapScreen,
  wrapTmux,
} from "../protocol/passthrough";
import { chooseSourceScale, detectCapability } from "./detect";

const ESC = String.fromCharCode(0x1b);

describe("detectCapability", () => {
  test("recognizes kitty from its window id", () => {
    const cap = detectCapability({ KITTY_WINDOW_ID: "1" });
    expect(cap.terminal).toBe("kitty");
    expect(cap.graphics).toBe("kitty");
  });

  test("recognizes ghostty and wezterm from their own variables", () => {
    expect(detectCapability({ GHOSTTY_RESOURCES_DIR: "/x" }).terminal).toBe("ghostty");
    expect(detectCapability({ WEZTERM_PANE: "0" }).terminal).toBe("wezterm");
  });

  test("reports no graphics for terminals known to lack the protocol", () => {
    expect(detectCapability({ WT_SESSION: "abc" }).graphics).toBe("none");
    expect(detectCapability({ TERM_PROGRAM: "Apple_Terminal" }).graphics).toBe("none");
  });

  test("stays unknown for an unrecognized terminal rather than assuming support", () => {
    const cap = detectCapability({ TERM: "xterm-256color" });
    expect(cap.terminal).toBe("unknown");
    expect(cap.graphics).toBe("unknown");
  });

  test("downgrades a capable terminal when a multiplexer is in the way", () => {
    const cap = detectCapability({ KITTY_WINDOW_ID: "1", TMUX: "/tmp/sock,1,0" });
    expect(cap.multiplexer).toBe("tmux");
    expect(cap.needsPassthrough).toBe(true);
    // Passthrough may be disabled in tmux config, which the environment cannot reveal.
    expect(cap.graphics).toBe("unknown");
  });

  test("keeps a known-incapable terminal incapable under a multiplexer", () => {
    expect(detectCapability({ WT_SESSION: "a", TMUX: "x" }).graphics).toBe("none");
  });

  test("reads true color from COLORTERM", () => {
    expect(detectCapability({ TERM: "xterm", COLORTERM: "truecolor" }).trueColor).toBe(true);
    expect(detectCapability({ TERM: "xterm" }).trueColor).toBe(false);
  });

  test("never claims to know the magnification filter", () => {
    // No runtime probe can answer this: the protocol does not report the filter
    // and rendered pixels cannot be read back through the pty.
    expect(detectCapability({ KITTY_WINDOW_ID: "1" }).magnification).toBe("unknown");
  });
});

describe("chooseSourceScale", () => {
  test("transmits at native resolution unless smooth magnification is confirmed", () => {
    const cap = detectCapability({ KITTY_WINDOW_ID: "1" });
    expect(chooseSourceScale(cap, 8)).toBe(1);
  });

  test("allows reduction only when the filter is known to be smooth", () => {
    const cap = { ...detectCapability({ KITTY_WINDOW_ID: "1" }), magnification: "smooth" as const };
    expect(chooseSourceScale(cap, 8)).toBe(8);
  });
});

describe("multiplexer passthrough", () => {
  test("detects tmux and screen from session variables only", () => {
    expect(detectMultiplexer({ TMUX: "/tmp/x,1,0" })).toBe("tmux");
    expect(detectMultiplexer({ STY: "1234.pts-0" })).toBe("screen");
    // TERM alone is not evidence: tmux itself sets TERM=screen-256color.
    expect(detectMultiplexer({ TERM: "screen-256color" })).toBe("none");
  });

  test("doubles escapes inside the tmux envelope so one layer survives stripping", () => {
    const wrapped = wrapTmux(`${ESC}_Ga=p;${ESC}\\`);
    expect(wrapped.startsWith(`${ESC}Ptmux;`)).toBe(true);
    expect(wrapped).toContain(ESC + ESC);
  });

  test("splits long payloads across screen envelopes", () => {
    const wrapped = wrapScreen("x".repeat(2000));
    expect(wrapped.split(`${ESC}P`).length - 1).toBe(3);
  });

  test("passes sequences through untouched when nothing is in the way", () => {
    const seq = `${ESC}_Ga=p;${ESC}\\`;
    expect(wrapForMultiplexer(seq, "none")).toBe(seq);
  });
});
