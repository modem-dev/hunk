import { describe, expect, test } from "bun:test";
import {
  TERMINAL_TEXT_TAB_WIDTH,
  TerminalTextMeasurer,
  measureTerminalTextHeight,
} from "./measurement";

describe("terminal text measurement", () => {
  test("matches native word wrapping for words and wide unbroken text", () => {
    expect(measureTerminalTextHeight("hello world", 7)).toBe(2);
    expect(measureTerminalTextHeight("hello world", 5)).toBe(3);
    expect(measureTerminalTextHeight("ab界界cd", 4)).toBe(3);
    expect(measureTerminalTextHeight("界", 1)).toBe(2);
  });
  test("measures retained tabs at their native fixed two-cell width", () => {
    expect(TERMINAL_TEXT_TAB_WIDTH).toBe(2);
    expect(measureTerminalTextHeight("a\tb", 1)).toBe(4);
    expect(measureTerminalTextHeight("a\tb", 2)).toBe(3);
    expect(measureTerminalTextHeight("a\tb", 3)).toBe(2);
    expect(measureTerminalTextHeight("a\tb", 4)).toBe(1);
    expect(measureTerminalTextHeight("\t\t", 1)).toBe(4);
    expect(measureTerminalTextHeight("\t\t", 2)).toBe(2);
    expect(measureTerminalTextHeight("\t\t", 3)).toBe(2);
    expect(measureTerminalTextHeight("\t\t", 4)).toBe(1);
  });
  test("contains setup failures and poisons the measurer", () => {
    let calls = 0;
    const measurer = new TerminalTextMeasurer(() => {
      calls++;
      throw new Error("native details");
    });
    expect(() => measurer.measure("content", 10)).toThrow("terminal text measurement unavailable");
    expect(() => measurer.measure("content", 10)).toThrow("terminal text measurement unavailable");
    expect(calls).toBe(1);
  });
  test("destroys native resources exactly once after measurement failures", () => {
    for (const failure of [
      "set-text",
      "wrap-mode",
      "wrap-width",
      "measure",
      "malformed-measure",
    ] as const) {
      let bufferDestroyed = 0;
      let viewDestroyed = 0;
      const measurer = new TerminalTextMeasurer(() => ({
        buffer: {
          setText() {
            if (failure === "set-text") throw new Error("failed");
          },
          destroy() {
            bufferDestroyed++;
          },
        },
        view: {
          setWrapMode() {
            if (failure === "wrap-mode") throw new Error("failed");
          },
          setWrapWidth() {
            if (failure === "wrap-width") throw new Error("failed");
          },
          measureForDimensions() {
            return failure === "measure"
              ? null
              : { lineCount: failure === "malformed-measure" ? Number.NaN : 1 };
          },
          destroy() {
            viewDestroyed++;
          },
        },
      }));
      expect(() => measurer.measure("content", 10)).toThrow(
        "terminal text measurement unavailable",
      );
      expect(bufferDestroyed).toBe(1);
      expect(viewDestroyed).toBe(1);
      expect(() => measurer.measure("other", 10)).toThrow("terminal text measurement unavailable");
      expect(bufferDestroyed).toBe(1);
      expect(viewDestroyed).toBe(1);
    }
  });
  test("keeps empty rows at height one without touching poisoned native state", () => {
    const measurer = new TerminalTextMeasurer(() => {
      throw new Error("unavailable");
    });
    expect(() => measurer.measure("content", 10)).toThrow("terminal text measurement unavailable");
    expect(measurer.measure("", 10)).toBe(1);
  });
});
