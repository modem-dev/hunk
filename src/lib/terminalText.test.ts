import { describe, expect, test } from "bun:test";
import { sanitizeTerminalSpans, sanitizeTerminalText } from "./terminalText";

const OSC52_CLIPBOARD = "\x1b]52;c;SGVsbG8=\x07";
const OSC_ST = "\x1b]8;;https://example.test\x1b\\";
const CSI_CLEAR_SCREEN = "\x1b[2J";
const DCS_PAYLOAD = "\x1bPqpayload\x1b\\";
const APC_PAYLOAD = "\x1b_payload\x1b\\";
const PM_PAYLOAD = "\x1b^payload\x1b\\";
const SOS_PAYLOAD = "\x1bXpayload\x1b\\";
const C1_OSC = "\x9d52;c;SGVsbG8=\x07";
const C1_CSI = "\x9b2J";
const C1_DCS = "\x90payload\x9c";

function expectNoUnsafeTerminalControls(text: string) {
  expect(text).not.toContain("\x1b");
  expect(text).not.toContain("\x07");
  expect(text).not.toContain("\x08");
  expect(text).not.toContain("\x0b");
  expect(text).not.toContain("\x0c");
  expect(text).not.toContain("\x0d");
  expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)).toBe(false);
}

describe("sanitizeTerminalText", () => {
  test("removes terminal control strings without dropping surrounding text", () => {
    const input = [
      "before",
      OSC52_CLIPBOARD,
      OSC_ST,
      CSI_CLEAR_SCREEN,
      DCS_PAYLOAD,
      APC_PAYLOAD,
      PM_PAYLOAD,
      SOS_PAYLOAD,
      C1_OSC,
      C1_CSI,
      C1_DCS,
      "after",
    ].join("");

    const output = sanitizeTerminalText(input);

    expect(output).toContain("before");
    expect(output).toContain("after");
    expectNoUnsafeTerminalControls(output);
  });

  test("neutralizes visual spoofing controls", () => {
    const output = sanitizeTerminalText("safe\rOVERWRITE\bhidden\x1b");

    expect(output).toContain("safe");
    expect(output).toContain("OVERWRITE");
    expect(output).toContain("hidden");
    expectNoUnsafeTerminalControls(output);
  });

  test("preserves ordinary multiline text and tabs when allowed", () => {
    expect(sanitizeTerminalText("alpha\n\tbeta")).toBe("alpha\n\tbeta");
  });

  test("sanitizes span text while preserving styling metadata", () => {
    const spans = [
      { text: `before${OSC52_CLIPBOARD}`, fg: "#fff" },
      { text: "\x1b[2J" },
      { text: "after", bg: "#000" },
    ];

    const output = sanitizeTerminalSpans(spans);

    expect(output).toEqual([
      { text: "before", fg: "#fff" },
      { text: "after", bg: "#000" },
    ]);
  });
});
