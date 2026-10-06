import { expect, test } from "bun:test";
import {
  completeDocumentGeometry,
  completeDocumentLines,
  completeDocumentWindow,
  completeDocumentScrollAnchor,
  completeDocumentScrollAnchorTop,
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

test("resolves logical anchors within surviving line extents and handles empty geometry", () => {
  const previous = completeDocumentGeometry(
    ["a".repeat(100), "b".repeat(100), "last"],
    10,
    false,
    true,
  );
  const anchor = completeDocumentScrollAnchor(previous, previous.rows[1]!.start + 8);
  expect(anchor).toEqual({ line: 1, offset: 8 });
  const next = completeDocumentGeometry(["a", "b".repeat(25)], 10, false, true);
  expect(completeDocumentScrollAnchorTop(next, anchor)).toBe(3);
  expect(completeDocumentScrollAnchorTop(next, { line: 200, offset: 0 })).toBe(1);
  expect(completeDocumentScrollAnchorTop(next, { line: 200, offset: 99 })).toBe(3);
  const empty = completeDocumentGeometry([], 10, false, true);
  expect(completeDocumentScrollAnchorTop(empty, anchor)).toBe(0);
  expect(completeDocumentScrollAnchor(empty, 100)).toEqual({ line: 0, offset: 0 });
  expect(completeDocumentScrollAnchor(next, 100)).toEqual({ line: 1, offset: 2 });
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
