import { describe, expect, test } from "bun:test";
import {
  createTestDiffFile,
  createTestHeaderOnlyDiffFile,
  lines,
} from "../../../../../test/helpers/diff-helpers";
import type { DiffFile } from "../../core/changeset/model";
import type { LayoutMode } from "../../core/run/commandInputs";
import { reviewGapId } from "../../core/review/expansion";
import { measureDiffSectionGeometry } from "../diff/diffSectionGeometry";
import { resolveTheme } from "../themes";
import {
  buildLineCursors,
  clampLineCursorToViewport,
  createLineCursorStabilizer,
  findLineCursorAt,
  findNextLineCursor,
  firstLineCursorInHunk,
  reuseEquivalentLineCursors,
  resolveLineCursor,
  type LineCursor,
} from "./lineCursors";

const theme = resolveTheme("github-dark-default", null);

/** Enumerate the stops the review stream renders for these files in one layout. */
function cursorsFor(files: DiffFile[], layout: Exclude<LayoutMode, "auto">) {
  return buildLineCursors(
    files,
    files.map((file) => measureDiffSectionGeometry(file, layout, true, theme)),
  );
}

/** Build a file whose single hunk wraps one changed line in context. */
function createContextWrappedFile(id: string, path: string) {
  return createTestDiffFile({
    id,
    path,
    before: lines("one", "two", "three", "four"),
    after: lines("one", "TWO", "three", "four"),
    context: 1,
  });
}

/** Build a file with two separated single-line changes and no context. */
function createTwoHunkFile(id: string, path: string) {
  return createTestDiffFile({
    id,
    path,
    before: lines("a", "b", "c", "d", "e", "f", "g", "h", "i", "j"),
    after: lines("A", "b", "c", "d", "e", "f", "g", "h", "i", "J"),
    context: 0,
  });
}

/** Build a file whose only change sits below a collapsible gap. */
function createCollapsedGapFile() {
  const before = lines("one", "two", "three", "four", "five", "six");
  return createTestDiffFile({
    id: "alpha",
    path: "alpha.ts",
    before,
    after: lines("one", "two", "three", "four", "five", "SIX"),
    context: 1,
  });
}

describe("buildLineCursors", () => {
  test("walks context and changed lines in rendered order", () => {
    const cursors = cursorsFor([createContextWrappedFile("alpha", "alpha.ts")], "stack");

    expect(cursors).toEqual([
      {
        fileId: "alpha",
        hunkIndex: 0,
        stableKey: "line:0:context:1:1",
        target: { side: "new", line: 1 },
      },
      {
        fileId: "alpha",
        hunkIndex: 0,
        stableKey: "line:0:old:2",
        target: { side: "old", line: 2 },
      },
      {
        fileId: "alpha",
        hunkIndex: 0,
        stableKey: "line:0:new:2",
        target: { side: "new", line: 2 },
      },
      {
        fileId: "alpha",
        hunkIndex: 0,
        stableKey: "line:0:context:3:3",
        target: { side: "new", line: 3 },
      },
    ]);
  });

  test("keeps old and new line numbering independent across hunks", () => {
    const cursors = cursorsFor([createTwoHunkFile("alpha", "alpha.ts")], "stack");

    expect(cursors.map((cursor) => ({ hunkIndex: cursor.hunkIndex, ...cursor.target }))).toEqual([
      { hunkIndex: 0, side: "old", line: 1 },
      { hunkIndex: 0, side: "new", line: 1 },
      { hunkIndex: 1, side: "old", line: 10 },
      { hunkIndex: 1, side: "new", line: 10 },
    ]);
  });

  test("pairs a change block's two sides per row in split layout", () => {
    const file = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: lines("a", "b", "c"),
      after: lines("A", "B", "C"),
      context: 0,
    });

    expect(cursorsFor([file], "split").map((cursor) => cursor.target)).toEqual([
      { side: "old", line: 1 },
      { side: "new", line: 1 },
      { side: "old", line: 2 },
      { side: "new", line: 2 },
      { side: "old", line: 3 },
      { side: "new", line: 3 },
    ]);
  });

  test("walks a change block one column at a time in stack layout", () => {
    const file = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: lines("a", "b", "c"),
      after: lines("A", "B", "C"),
      context: 0,
    });

    expect(cursorsFor([file], "stack").map((cursor) => cursor.target)).toEqual([
      { side: "old", line: 1 },
      { side: "old", line: 2 },
      { side: "old", line: 3 },
      { side: "new", line: 1 },
      { side: "new", line: 2 },
      { side: "new", line: 3 },
    ]);
  });

  test("stops on the lines an expanded gap reveals", () => {
    const file = createCollapsedGapFile();
    const source = lines("one", "two", "three", "four", "five", "SIX");
    const collapsed = measureDiffSectionGeometry(file, "stack", true, theme);
    const expanded = measureDiffSectionGeometry(
      file,
      "stack",
      true,
      theme,
      [],
      120,
      true,
      false,
      new Set([reviewGapId("before", 0)]),
      { kind: "loaded", text: source },
    );

    const collapsedLines = buildLineCursors([file], [collapsed]).map(
      (cursor) => cursor.target.line,
    );
    const expandedLines = buildLineCursors([file], [expanded]).map((cursor) => cursor.target.line);

    expect(collapsedLines).not.toContain(1);
    expect(expandedLines).toContain(1);
    expect(expandedLines.length).toBeGreaterThan(collapsedLines.length);
  });

  test("flattens every visible file into one review stream", () => {
    const cursors = cursorsFor(
      [createTwoHunkFile("alpha", "alpha.ts"), createTwoHunkFile("beta", "beta.ts")],
      "stack",
    );

    expect(cursors).toHaveLength(8);
    expect(cursors.slice(0, 4).every((cursor) => cursor.fileId === "alpha")).toBe(true);
    expect(cursors.slice(4).every((cursor) => cursor.fileId === "beta")).toBe(true);
  });

  test("gives no stops to a file the stream renders no source lines for", () => {
    const empty = createTestHeaderOnlyDiffFile();
    const cursors = cursorsFor([createTwoHunkFile("alpha", "alpha.ts"), empty], "stack");

    expect(cursors.some((cursor) => cursor.fileId === "alpha")).toBe(true);
    expect(cursors.some((cursor) => cursor.fileId === empty.id)).toBe(false);
    expect(firstLineCursorInHunk(cursors, empty.id, 0)).toBeNull();
  });

  test("returns nothing when no files are visible", () => {
    expect(buildLineCursors([], [])).toEqual([]);
  });
});

describe("reuseEquivalentLineCursors", () => {
  test("keeps list identity when remeasurement preserves every cursor", () => {
    const previous = cursorsFor([createContextWrappedFile("alpha", "alpha.ts")], "stack");
    const next = previous.map((cursor) => ({ ...cursor, target: { ...cursor.target } }));

    expect(reuseEquivalentLineCursors(previous, next)).toBe(previous);
  });

  test("keeps a changed cursor list", () => {
    const previous = cursorsFor([createContextWrappedFile("alpha", "alpha.ts")], "stack");
    const next = previous.map((cursor, index) =>
      index === 0
        ? { ...cursor, target: { ...cursor.target, line: cursor.target.line + 1 } }
        : cursor,
    );

    expect(reuseEquivalentLineCursors(previous, next)).toBe(next);
  });
});

describe("createLineCursorStabilizer", () => {
  test("does not rescan an unchanged measurement during unrelated renders", () => {
    const stabilize = createLineCursorStabilizer();
    const measured = cursorsFor([createContextWrappedFile("alpha", "alpha.ts")], "stack");

    expect(stabilize(measured)).toBe(measured);
    expect(stabilize(measured)).toBe(measured);
  });

  test("preserves stable cursor identity across equivalent remeasurement", () => {
    const stabilize = createLineCursorStabilizer();
    const stable = cursorsFor([createContextWrappedFile("alpha", "alpha.ts")], "stack");
    const measured = stable.map((cursor) => ({ ...cursor, target: { ...cursor.target } }));

    expect(stabilize(stable)).toBe(stable);
    expect(stabilize(measured)).toBe(stable);
  });
});

describe("findLineCursorAt", () => {
  /** Build a file whose inserted line pushes the trailing context onto different side numbers. */
  function createShiftedContextFile() {
    return createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: lines("one", "two", "three"),
      after: lines("one", "inserted", "two", "three"),
      context: 3,
    });
  }

  test("finds a changed line by the side the patch numbers it on", () => {
    const cursors = cursorsFor([createTwoHunkFile("alpha", "alpha.ts")], "stack");

    expect(findLineCursorAt(cursors, "alpha", "new", 10)?.target).toEqual({
      side: "new",
      line: 10,
    });
    expect(findLineCursorAt(cursors, "alpha", "old", 10)?.target).toEqual({
      side: "old",
      line: 10,
    });
  });

  test("answers a context row to either side's number, even once they diverge", () => {
    // "three" is old line 3 and new line 4 after the insertion; both address the same row.
    const cursors = cursorsFor([createShiftedContextFile()], "stack");
    const byNew = findLineCursorAt(cursors, "alpha", "new", 4);
    const byOld = findLineCursorAt(cursors, "alpha", "old", 3);

    expect(byNew?.stableKey).toBe("line:0:context:3:4");
    expect(byOld).toEqual(byNew);
  });

  test("stays inside the requested file when two files number the same line", () => {
    const cursors = cursorsFor(
      [createTwoHunkFile("alpha", "alpha.ts"), createTwoHunkFile("beta", "beta.ts")],
      "stack",
    );

    expect(findLineCursorAt(cursors, "beta", "new", 1)?.fileId).toBe("beta");
  });

  test("finds no cursor for a line the stream draws no row for", () => {
    // Line 3 is inside the collapsed gap above the only hunk, so nothing measures it.
    const cursors = cursorsFor([createCollapsedGapFile()], "stack");

    expect(findLineCursorAt(cursors, "alpha", "new", 3)).toBeNull();
    expect(findLineCursorAt(cursors, "alpha", "new", 900)).toBeNull();
    expect(findLineCursorAt(cursors, "missing", "new", 6)).toBeNull();
  });
});

describe("findNextLineCursor", () => {
  const cursors = cursorsFor(
    [createTwoHunkFile("alpha", "alpha.ts"), createTwoHunkFile("beta", "beta.ts")],
    "stack",
  );

  test("steps forward and backward one line at a time", () => {
    expect(findNextLineCursor(cursors, cursors[0]!, 1)).toEqual(cursors[1]!);
    expect(findNextLineCursor(cursors, cursors[1]!, -1)).toEqual(cursors[0]!);
  });

  test("rolls across hunk and file boundaries", () => {
    expect(findNextLineCursor(cursors, cursors[1]!, 1)).toEqual(cursors[2]!);
    expect(findNextLineCursor(cursors, cursors[3]!, 1)).toEqual(cursors[4]!);
    expect(findNextLineCursor(cursors, cursors[4]!, -1)).toEqual(cursors[3]!);
  });

  test("clamps at both ends instead of wrapping", () => {
    expect(findNextLineCursor(cursors, cursors[0]!, -1)).toEqual(cursors[0]!);
    expect(findNextLineCursor(cursors, cursors[cursors.length - 1]!, 1)).toEqual(
      cursors[cursors.length - 1]!,
    );
  });

  test("starts at the top of the stream when no cursor is set", () => {
    expect(findNextLineCursor(cursors, null, 1)).toEqual(cursors[0]!);
    expect(findNextLineCursor(cursors, null, -1)).toEqual(cursors[0]!);
  });

  test("recovers to the top when the current line left the stream", () => {
    const retired: LineCursor = {
      fileId: "gamma",
      hunkIndex: 4,
      stableKey: "line:4:new:99",
      target: { side: "new", line: 99 },
    };

    expect(findNextLineCursor(cursors, retired, 1)).toEqual(cursors[0]!);
  });

  test("returns nothing when the stream is empty", () => {
    expect(findNextLineCursor([], null, 1)).toBeNull();
  });
});

describe("firstLineCursorInHunk", () => {
  const cursors = cursorsFor(
    [createTwoHunkFile("alpha", "alpha.ts"), createTwoHunkFile("beta", "beta.ts")],
    "stack",
  );

  test("seeds at the first line of the requested hunk", () => {
    expect(firstLineCursorInHunk(cursors, "beta", 1)).toEqual({
      fileId: "beta",
      hunkIndex: 1,
      stableKey: "line:1:old:10",
      target: { side: "old", line: 10 },
    });
  });

  test("falls back within the file when the hunk is gone", () => {
    expect(firstLineCursorInHunk(cursors, "beta", 7)?.fileId).toBe("beta");
  });

  test("falls back to the top of the stream without a selected file", () => {
    expect(firstLineCursorInHunk(cursors, undefined, 0)).toEqual(cursors[0]!);
  });

  test("returns nothing when the selected file has no navigable lines", () => {
    expect(firstLineCursorInHunk(cursors, "gamma", 0)).toBeNull();
  });

  test("returns nothing when the stream is empty", () => {
    expect(firstLineCursorInHunk([], "alpha", 0)).toBeNull();
  });
});

describe("resolveLineCursor", () => {
  const cursors = cursorsFor([createTwoHunkFile("alpha", "alpha.ts")], "stack");

  test("keeps a cursor that still points at a real line", () => {
    expect(resolveLineCursor(cursors, cursors[2]!)).toEqual(cursors[2]!);
  });

  test("falls back to the same hunk when the line is gone", () => {
    const movedLine: LineCursor = {
      fileId: "alpha",
      hunkIndex: 1,
      stableKey: "line:1:new:42",
      target: { side: "new", line: 42 },
    };

    expect(resolveLineCursor(cursors, movedLine)).toEqual({
      fileId: "alpha",
      hunkIndex: 1,
      stableKey: "line:1:old:10",
      target: { side: "old", line: 10 },
    });
  });

  test("falls back to the same file when the hunk is gone", () => {
    const retiredHunk: LineCursor = {
      fileId: "alpha",
      hunkIndex: 9,
      stableKey: "line:9:new:1",
      target: { side: "new", line: 1 },
    };

    expect(resolveLineCursor(cursors, retiredHunk)?.fileId).toBe("alpha");
  });

  test("gives up when the file left the review stream", () => {
    const filteredOut: LineCursor = {
      fileId: "gamma",
      hunkIndex: 0,
      stableKey: "line:0:new:1",
      target: { side: "new", line: 1 },
    };

    expect(resolveLineCursor(cursors, filteredOut)).toBeNull();
  });

  test("gives up when there is no cursor to resolve", () => {
    expect(resolveLineCursor(cursors, null)).toBeNull();
  });
});

describe("clampLineCursorToViewport", () => {
  const cursors = cursorsFor([createTwoHunkFile("alpha", "alpha.ts")], "stack");
  const boundsOf = (cursor: LineCursor) => {
    const index = cursors.findIndex((candidate) => candidate.stableKey === cursor.stableKey);
    return index < 0 ? undefined : { top: index, height: 1 };
  };

  test("leaves a visible current line where it is", () => {
    expect(
      clampLineCursorToViewport({
        boundsOf,
        current: cursors[1]!,
        cursors,
        scrollTop: 0,
        viewportHeight: 3,
      }),
    ).toEqual(cursors[1]!);
  });

  test("snaps down to the first visible line after scrolling past it", () => {
    expect(
      clampLineCursorToViewport({
        boundsOf,
        current: cursors[0]!,
        cursors,
        scrollTop: 2,
        viewportHeight: 2,
      }),
    ).toEqual(cursors[2]!);
  });

  test("snaps up to the last visible line after scrolling back above it", () => {
    expect(
      clampLineCursorToViewport({
        boundsOf,
        current: cursors[3]!,
        cursors,
        scrollTop: 0,
        viewportHeight: 2,
      }),
    ).toEqual(cursors[1]!);
  });

  test("adopts the first visible line when the current one left the stream", () => {
    const retired: LineCursor = {
      fileId: "alpha",
      hunkIndex: 9,
      stableKey: "line:9:new:1",
      target: { side: "new", line: 1 },
    };

    expect(
      clampLineCursorToViewport({
        boundsOf,
        current: retired,
        cursors,
        scrollTop: 1,
        viewportHeight: 2,
      }),
    ).toEqual(cursors[1]!);
  });

  test("keeps the current line when there is nothing to clamp to", () => {
    expect(
      clampLineCursorToViewport({
        boundsOf,
        current: cursors[0]!,
        cursors: [],
        scrollTop: 40,
        viewportHeight: 4,
      }),
    ).toEqual(cursors[0]!);
  });
});
