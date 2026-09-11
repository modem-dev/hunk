import { describe, expect, test } from "bun:test";
import {
  FILE_VIEW_TAB_WIDTH,
  FileViewTextMeasurer,
  measureFileViewDisplayTextHeight,
} from "./textDisplay";

describe("file-view terminal text display", () => {
  test("matches native word wrapping for words and wide unbroken text", () => {
    expect(measureFileViewDisplayTextHeight("hello world", 7)).toBe(2);
    expect(measureFileViewDisplayTextHeight("hello world", 5)).toBe(3);
    expect(measureFileViewDisplayTextHeight("ab界界cd", 4)).toBe(3);
    expect(measureFileViewDisplayTextHeight("界", 1)).toBe(2);
  });

  test("measures retained tabs at their native fixed two-cell width", () => {
    expect(FILE_VIEW_TAB_WIDTH).toBe(2);
    expect(measureFileViewDisplayTextHeight("a\tb", 1)).toBe(4);
    expect(measureFileViewDisplayTextHeight("a\tb", 2)).toBe(3);
    expect(measureFileViewDisplayTextHeight("a\tb", 3)).toBe(2);
    expect(measureFileViewDisplayTextHeight("a\tb", 4)).toBe(1);
    expect(measureFileViewDisplayTextHeight("\t\t", 1)).toBe(4);
    expect(measureFileViewDisplayTextHeight("\t\t", 2)).toBe(2);
    expect(measureFileViewDisplayTextHeight("\t\t", 3)).toBe(2);
    expect(measureFileViewDisplayTextHeight("\t\t", 4)).toBe(1);
  });

  test("throws a bounded error and poisons the measurer after native setup fails", () => {
    let factoryCalls = 0;
    const measurer = new FileViewTextMeasurer(() => {
      factoryCalls += 1;
      throw new Error("native detail that must not escape");
    });

    expect(() => measurer.measure("content", 10)).toThrow("file-view text measurement unavailable");
    expect(() => measurer.measure("content", 10)).toThrow("file-view text measurement unavailable");
    expect(factoryCalls).toBe(1);
  });

  test("destroys native resources and returns no height after any measurement failure", () => {
    for (const failure of [
      "set-text",
      "wrap-mode",
      "wrap-width",
      "measure",
      "malformed-measure",
    ] as const) {
      let bufferDestroyed = 0;
      let viewDestroyed = 0;
      const measurer = new FileViewTextMeasurer(() => ({
        buffer: {
          setText() {
            if (failure === "set-text") throw new Error("set text failed");
          },
          destroy() {
            bufferDestroyed += 1;
          },
        },
        view: {
          setWrapMode() {
            if (failure === "wrap-mode") throw new Error("wrap mode failed");
          },
          setWrapWidth() {
            if (failure === "wrap-width") throw new Error("wrap width failed");
          },
          measureForDimensions() {
            if (failure === "measure") return null;
            return { lineCount: failure === "malformed-measure" ? Number.NaN : 1 };
          },
          destroy() {
            viewDestroyed += 1;
          },
        },
      }));

      expect(() => measurer.measure("content", 10)).toThrow(
        "file-view text measurement unavailable",
      );
      expect(bufferDestroyed).toBe(1);
      expect(viewDestroyed).toBe(1);
      expect(() => measurer.measure("other", 10)).toThrow("file-view text measurement unavailable");
      expect(bufferDestroyed).toBe(1);
      expect(viewDestroyed).toBe(1);
    }
  });

  test("keeps empty rows at height one without touching poisoned native state", () => {
    const measurer = new FileViewTextMeasurer(() => {
      throw new Error("unavailable");
    });

    expect(() => measurer.measure("content", 10)).toThrow("file-view text measurement unavailable");
    expect(measurer.measure("", 10)).toBe(1);
  });
});
