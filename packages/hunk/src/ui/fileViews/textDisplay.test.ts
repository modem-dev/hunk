import { describe, expect, test } from "bun:test";
import {
  FILE_VIEW_TAB_WIDTH,
  fileViewDisplaySpans,
  fileViewDisplayText,
  measureFileViewDisplayTextHeight,
} from "./textDisplay";

describe("file-view terminal text display", () => {
  test("expands OpenTUI-width tabs after preserving styled boundaries", () => {
    expect(FILE_VIEW_TAB_WIDTH).toBe(2);
    expect(fileViewDisplayText("a\tb")).toBe("a  b");
    expect(
      fileViewDisplaySpans([
        { text: "a\t", style: "left" },
        { text: "b", style: "right" },
      ]),
    ).toEqual([
      { text: "a  ", style: "left" },
      { text: "b", style: "right" },
    ]);
  });

  test("matches OpenTUI word-wrap counts for exact fills, words, and display tabs", () => {
    expect(measureFileViewDisplayTextHeight("hello world", 7)).toBe(2);
    expect(measureFileViewDisplayTextHeight("hello world", 5)).toBe(3);
    expect(measureFileViewDisplayTextHeight("\t12345678", 7)).toBe(3);
    expect(measureFileViewDisplayTextHeight("a\tb", 2)).toBe(2);
    expect(measureFileViewDisplayTextHeight("ab\tcd", 3)).toBe(2);
  });
});
