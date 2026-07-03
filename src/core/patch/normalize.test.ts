import { describe, expect, test } from "bun:test";
import { escapeUntrackedPatchPath, normalizePatchText, stripTerminalControl } from "./normalize";

describe("escapeUntrackedPatchPath", () => {
  test("escapes backslashes before whitespace so escape markers are not doubled", () => {
    // A literal backslash followed by a tab must become `\\` + `\t`, not `\` + `\\t`.
    expect(escapeUntrackedPatchPath("a\\\tb")).toBe("a\\\\\\tb");
  });

  test("escapes tab, newline, and carriage return into header-safe sequences", () => {
    expect(escapeUntrackedPatchPath("a\tb")).toBe("a\\tb");
    expect(escapeUntrackedPatchPath("a\nb\rc")).toBe("a\\nb\\rc");
  });

  test("leaves ordinary path characters untouched", () => {
    expect(escapeUntrackedPatchPath("src/foo bar.ts")).toBe("src/foo bar.ts");
  });
});

describe("stripTerminalControl", () => {
  test("removes SGR color sequences while keeping the visible text", () => {
    expect(stripTerminalControl("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  test("removes OSC sequences terminated by BEL", () => {
    expect(stripTerminalControl("\x1b]0;title\x07keep")).toBe("keep");
  });

  test("removes OSC hyperlink sequences terminated by ST", () => {
    expect(stripTerminalControl("\x1b]8;;url\x1b\\link")).toBe("link");
  });

  test("removes DCS sequences", () => {
    expect(stripTerminalControl("\x1bPsomedata\x1b\\keep")).toBe("keep");
  });

  test("removes lone two-byte escape sequences", () => {
    expect(stripTerminalControl("a\x1bMb")).toBe("ab");
  });

  test("leaves text with no control sequences unchanged", () => {
    expect(stripTerminalControl("plain diff text")).toBe("plain diff text");
  });
});

describe("normalizePatchText", () => {
  test("converts CRLF to LF and canonicalizes git prefixes in one pass", () => {
    expect(normalizePatchText("diff --git foo foo\r\n--- foo\r\n+++ foo\r\n")).toBe(
      "diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n",
    );
  });

  test("strips color codes from pager-style colored patch input before parsing", () => {
    const colored = "\x1b[1mdiff --git foo foo\x1b[0m\n--- foo\n+++ foo\n";
    expect(normalizePatchText(colored)).toBe("diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n");
  });

  test("strips git-log commit metadata ahead of the diff body", () => {
    const log = [
      "commit 1234567890abcdef",
      "Author: A <a@b>",
      "Date: now",
      "",
      "    message",
      "",
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "",
    ].join("\n");
    expect(normalizePatchText(log)).toBe("diff --git a/f b/f\n--- a/f\n+++ b/f\n");
  });
});
