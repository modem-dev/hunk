import { expect, test } from "bun:test";
import {
  completeDocumentGeometry,
  completeDocumentLines,
  completeDocumentWindow,
} from "./geometry";

test("normalizes newlines, preserves empty logical lines and strips terminal controls", () => {
  expect(completeDocumentLines("")).toEqual([]);
  expect(completeDocumentLines("\n")).toEqual([""]);
  expect(completeDocumentLines("one\r\n\r\ntwo\r")).toEqual(["one", "", "two"]);
  expect(completeDocumentLines("safe\x1b[2Jtext\n")).toEqual(["safetext"]);
  expect(completeDocumentLines("界\tx\n", 4)).toEqual(["界  x"]);
  expect(completeDocumentLines("a\tb\tc\n", 4)).toEqual(["a   b   c"]);
});

test("measures complete-document wraps with the same native engine as file-view rows", () => {
  const geometry = completeDocumentGeometry(["hello world", "last"], 7, false, true);
  expect(geometry.rows).toEqual([
    { start: 0, height: 2 },
    { start: 2, height: 1 },
  ]);
  expect(geometry.totalHeight).toBe(3);
  expect(geometry.width).toBe(7);
  const unwrapped = completeDocumentGeometry(["hello world", "last"], 7, false, false);
  expect(unwrapped.rows.map((row) => row.height)).toEqual([1, 1]);
  expect(unwrapped.width).toBe(11);
});

test("windows by physical rows and mounts an intersecting wrapped logical line", () => {
  const geometry = completeDocumentGeometry(
    Array.from({ length: 100 }, () => "hello world"),
    7,
    false,
    true,
  );
  const window = completeDocumentWindow(geometry, 50, 10);
  expect(window).toEqual({ start: 22, end: 33 });
  expect(window.end - window.start).toBeLessThan(20);
  expect(completeDocumentWindow(geometry, 10_000, 10)).toEqual({ start: 100, end: 100 });
});
