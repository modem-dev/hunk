import { describe, expect, test } from "bun:test";
import {
  FILE_VIEW_TAB_WIDTH,
  measureFileViewDisplayTextHeight,
  measureFileViewTextHeightFallbackForTest,
} from "./textDisplay";

describe("file-view terminal text display", () => {
  test("matches native word wrapping for words and wide unbroken text", () => {
    expect(measureFileViewDisplayTextHeight("hello world", 7)).toBe(2);
    expect(measureFileViewDisplayTextHeight("hello world", 5)).toBe(3);
    expect(measureFileViewDisplayTextHeight("ab界界cd", 4)).toBe(3);
    expect(measureFileViewDisplayTextHeight("界", 1)).toBe(2);
  });

  test("keeps the native-failure fallback aligned for tabs, words, and wide graphemes", () => {
    const cases = ["hello world", "ab界界cd", "界", "a\tb", "\t\t", "\ta\t", "a\t\tb"];
    for (const text of cases) {
      for (const width of [1, 2, 3, 4, 7]) {
        expect(measureFileViewTextHeightFallbackForTest(text, width)).toBe(
          measureFileViewDisplayTextHeight(text, width),
        );
      }
    }
  });

  test("measures retained tabs as indivisible native two-cell units", () => {
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
});
