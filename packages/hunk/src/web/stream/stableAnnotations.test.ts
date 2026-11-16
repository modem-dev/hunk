import { describe, expect, test } from "bun:test";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { stabilizeLineAnnotations } from "./stableAnnotations";

interface TestMetadata {
  key: string;
  text: string;
}

/** One annotation on a line, with fresh objects every call as a rebuild produces them. */
function createTestAnnotation(line: number, text: string): DiffLineAnnotation<TestMetadata> {
  return { side: "additions", lineNumber: line, metadata: { key: `new:${line}`, text } };
}

describe("stabilizeLineAnnotations", () => {
  // Intent: a rebuild with equal content must hand Pierre the same objects, or it redraws the
  // annotation and an open composer in it is torn down.
  test("keeps the previous list and objects when nothing changed", () => {
    const first = stabilizeLineAnnotations(undefined, [
      createTestAnnotation(3, "a"),
      createTestAnnotation(9, "b"),
    ]);
    const second = stabilizeLineAnnotations(first, [
      createTestAnnotation(3, "a"),
      createTestAnnotation(9, "b"),
    ]);

    expect(second.list).toBe(first.list);
  });

  test("replaces only the annotations whose content changed", () => {
    const first = stabilizeLineAnnotations(undefined, [
      createTestAnnotation(3, "a"),
      createTestAnnotation(9, "b"),
    ]);
    const second = stabilizeLineAnnotations(first, [
      createTestAnnotation(3, "a"),
      createTestAnnotation(9, "changed"),
    ]);

    expect(second.list).not.toBe(first.list);
    expect(second.list[0]).toBe(first.list[0]!);
    expect(second.list[1]).not.toBe(first.list[1]!);
    expect(second.list[1]?.metadata.text).toBe("changed");
  });

  test("keeps surviving annotations when one is added or removed", () => {
    const first = stabilizeLineAnnotations(undefined, [createTestAnnotation(9, "b")]);
    const added = stabilizeLineAnnotations(first, [
      createTestAnnotation(3, "a"),
      createTestAnnotation(9, "b"),
    ]);
    expect(added.list[1]).toBe(first.list[0]!);

    const removed = stabilizeLineAnnotations(added, [createTestAnnotation(9, "b")]);
    expect(removed.list[0]).toBe(first.list[0]!);
  });
});
