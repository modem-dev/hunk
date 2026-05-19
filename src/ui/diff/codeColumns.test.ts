import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../../core/types";
import { maxFileCodeLineWidth } from "./codeColumns";

/** Generate a large diff metadata fixture without checking a huge file into the repo. */
function createLargeLineFixture(lineCount: number, widestLine: string): DiffFile {
  const additionLines = Array.from({ length: lineCount }, (_, index) =>
    index === lineCount - 1 ? widestLine : "x",
  );

  return {
    agent: null,
    id: "large-untracked",
    metadata: {
      additionLines,
      deletionLines: [],
      hunks: [],
    } as unknown as DiffFile["metadata"],
    patch: "",
    path: "large-untracked.txt",
    stats: { additions: lineCount, deletions: 0 },
  };
}

describe("code column measurement", () => {
  test("measures large generated fixtures without overflowing the call stack", () => {
    const file = createLargeLineFixture(100_000, "the widest generated line");

    expect(maxFileCodeLineWidth(file)).toBe("the widest generated line".length);
  });
});
