import { describe, expect, test } from "bun:test";
import { reviewGapId } from "../../core/review/expansion";
import { expandCollapsedRows } from "./expandCollapsedRows";
import type { DiffRow } from "./diffRows";

function makeCollapsedRow(
  position: "before" | "trailing",
  hunkIndex: number,
  oldRange: [number, number],
  newRange: [number, number],
): Extract<DiffRow, { type: "collapsed" }> {
  return {
    type: "collapsed",
    key: `f:collapsed:${position}:${hunkIndex}`,
    fileId: "f",
    hunkIndex,
    text: `${oldRange[1] - oldRange[0] + 1} unchanged lines`,
    position,
    oldRange,
    newRange,
  };
}

function makeHunkHeader(hunkIndex: number): Extract<DiffRow, { type: "hunk-header" }> {
  return {
    type: "hunk-header",
    key: `f:header:${hunkIndex}`,
    fileId: "f",
    hunkIndex,
    text: `@@ hunk ${hunkIndex} @@`,
  };
}

const SOURCE = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].join("\n") + "\n";
const OSC52_CLIPBOARD = "\x1b]52;c;SGVsbG8=\x07";
const CSI_CLEAR_SCREEN = "\x1b[2J";
const DCS_PAYLOAD = "\x1bPqpayload\x1b\\";

function expectNoUnsafeTerminalControls(text: string) {
  expect(text).not.toContain(OSC52_CLIPBOARD);
  expect(text).not.toContain(CSI_CLEAR_SCREEN);
  expect(text).not.toContain(DCS_PAYLOAD);
  expect(text).not.toContain("\x07");
  expect(text).not.toContain("\r");
  expect(text).not.toContain("\b");
  expect(text).not.toContain("\x1b");
}

describe("expandCollapsedRows", () => {
  test("returns rows unchanged when no gaps are expanded", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [1, 2], [1, 2]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "split",
      expandedKeys: new Set(),
      sourceStatus: { kind: "loaded", text: SOURCE },
      side: "new",
    });

    expect(result).toBe(rows);
  });

  test("leaves the row unchanged when expansion is requested before status arrives", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [1, 2], [1, 2]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "split",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: undefined,
      side: "new",
    });

    expect(result.map((row) => row.type)).toEqual(["collapsed", "hunk-header"]);
    const collapsed = result[0];
    if (!collapsed || collapsed.type !== "collapsed") {
      throw new Error("expected first row to be collapsed");
    }
    expect(collapsed.text.toLowerCase()).not.toContain("hide");
    expect(collapsed.text.toLowerCase()).not.toContain("loading");
  });

  test("rewrites the label to 'Loading…' while source is being fetched", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [1, 3], [1, 3]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "split",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "loading" },
      side: "new",
    });

    expect(result.map((row) => row.type)).toEqual(["collapsed", "hunk-header"]);
    const collapsed = result[0];
    if (!collapsed || collapsed.type !== "collapsed") {
      throw new Error("expected first row to be collapsed");
    }
    expect(collapsed.text.toLowerCase()).toContain("loading");
  });

  test("rewrites the label when source could not be loaded", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [1, 3], [1, 3]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "split",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "error" },
      side: "new",
    });

    expect(result.map((row) => row.type)).toEqual(["collapsed", "hunk-header"]);
    const collapsed = result[0];
    if (!collapsed || collapsed.type !== "collapsed") {
      throw new Error("expected first row to be collapsed");
    }
    expect(collapsed.text.toLowerCase()).toContain("could not load");
  });

  test("rewrites the label when source is too large to expand", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [1, 3], [1, 3]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "split",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "error", reason: "too-large" },
      side: "new",
    });

    const collapsed = result[0];
    if (!collapsed || collapsed.type !== "collapsed") {
      throw new Error("expected first row to be collapsed");
    }
    expect(collapsed.text.toLowerCase()).toContain("source too large");
  });

  test("inserts split-line context rows after the expanded collapsed row", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [1, 3], [1, 3]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "split",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "loaded", text: SOURCE },
      side: "new",
    });

    expect(result.length).toBe(rows.length + 3);
    expect(result[0]?.type).toBe("collapsed");

    const inserted = result.slice(1, 4);
    expect(inserted.every((row) => row.type === "split-line")).toBe(true);

    const first = inserted[0];
    if (!first || first.type !== "split-line") {
      throw new Error("expected split-line context rows");
    }

    expect(first.left.kind).toBe("context");
    expect(first.right.kind).toBe("context");
    expect(first.left.lineNumber).toBe(1);
    expect(first.right.lineNumber).toBe(1);
    expect(first.left.spans[0]?.text).toBe("alpha");
    expect(first.right.spans[0]?.text).toBe("alpha");
    expect(first.expandedGapKey).toBe(reviewGapId("before", 0));

    const third = inserted[2];
    if (!third || third.type !== "split-line") {
      throw new Error("expected three context rows");
    }
    expect(third.left.lineNumber).toBe(3);
    expect(third.right.spans[0]?.text).toBe("gamma");
  });

  test("inserts stack-line context rows when layout is stack", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [2, 3], [2, 3]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "stack",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "loaded", text: SOURCE },
      side: "new",
    });

    const inserted = result.slice(1, 3);
    expect(inserted.every((row) => row.type === "stack-line")).toBe(true);

    const first = inserted[0];
    if (!first || first.type !== "stack-line") {
      throw new Error("expected stack-line context rows");
    }
    expect(first.cell.kind).toBe("context");
    expect(first.cell.oldLineNumber).toBe(2);
    expect(first.cell.newLineNumber).toBe(2);
    expect(first.cell.spans[0]?.text).toBe("beta");
    expect(first.expandedGapKey).toBe(reviewGapId("before", 0));
  });

  test("changes the collapsed-row label to indicate expansion", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [1, 2], [1, 2]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "split",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "loaded", text: SOURCE },
      side: "new",
    });

    const collapsed = result[0];
    if (!collapsed || collapsed.type !== "collapsed") {
      throw new Error("expected first row to be the collapsed marker");
    }
    expect(collapsed.text.toLowerCase()).toContain("hide");
  });

  test("expands trailing gaps from the requested side", () => {
    const rows: DiffRow[] = [makeHunkHeader(0), makeCollapsedRow("trailing", 0, [4, 6], [4, 6])];

    const result = expandCollapsedRows(rows, {
      layout: "stack",
      expandedKeys: new Set([reviewGapId("trailing", 0)]),
      sourceStatus: { kind: "loaded", text: SOURCE },
      side: "new",
    });

    expect(result.length).toBe(rows.length + 3);
    const last = result[result.length - 1];
    if (!last || last.type !== "stack-line") {
      throw new Error("expected synthesized stack-line rows after the trailing collapsed row");
    }
    expect(last.cell.spans[0]?.text).toBe("zeta");
    expect(last.cell.newLineNumber).toBe(6);
  });

  test("uses the old-side range when side is `old`", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [2, 3], [10, 11]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "split",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "loaded", text: SOURCE },
      side: "old",
    });

    const inserted = result.slice(1, 3);
    const first = inserted[0];
    if (!first || first.type !== "split-line") {
      throw new Error("expected split-line context rows");
    }
    expect(first.left.lineNumber).toBe(2);
    expect(first.right.lineNumber).toBe(10);
    expect(first.left.spans[0]?.text).toBe("beta");
    expect(first.right.spans[0]?.text).toBe("beta");
  });

  test("normalizes CRLF so expanded rows do not carry a stray carriage return", () => {
    const sourceWithCrlf = "alpha\r\nbeta\r\ngamma\r\n";
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [1, 2], [1, 2]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "stack",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "loaded", text: sourceWithCrlf },
      side: "new",
    });

    const inserted = result[1];
    if (!inserted || inserted.type !== "stack-line") {
      throw new Error("expected stack-line context row");
    }
    expect(inserted.cell.spans[0]?.text).toBe("alpha");
  });

  test("does not pass terminal controls through expanded source rows", () => {
    const sourceWithControls = `safe${OSC52_CLIPBOARD}${CSI_CLEAR_SCREEN}${DCS_PAYLOAD}\x07\rspoof\bhidden\x1b\nfollow\n`;
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [1, 1], [1, 1]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "stack",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "loaded", text: sourceWithControls },
      side: "new",
    });

    const inserted = result[1];
    if (!inserted || inserted.type !== "stack-line") {
      throw new Error("expected one stack-line row");
    }

    const text = inserted.cell.spans.map((span) => span.text).join("");
    expect(text).toContain("safe");
    expect(text).toContain("spoof");
    expect(text).toContain("hidden");
    expectNoUnsafeTerminalControls(text);
  });

  test("expands tabs in source lines so terminal cells stay aligned", () => {
    const sourceWithTab = "a\tb\nfollow\n";
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [1, 1], [1, 1]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "stack",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "loaded", text: sourceWithTab },
      tabWidth: 4,
      side: "new",
    });

    const inserted = result[1];
    if (!inserted || inserted.type !== "stack-line") {
      throw new Error("expected one stack-line row");
    }
    expect(inserted.cell.spans[0]?.text).toBe("a   b");
  });

  test("uses caller-provided spans for expanded source lines", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [2, 3], [2, 3]), makeHunkHeader(0)];
    const calls: Array<{ line: string | undefined; sourceLineNumber: number }> = [];

    const result = expandCollapsedRows(rows, {
      layout: "stack",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "loaded", text: SOURCE },
      sourceLineSpans: (line, sourceLineNumber) => {
        calls.push({ line, sourceLineNumber });
        return [{ text: `highlighted:${line ?? ""}`, fg: "#abcdef" }];
      },
      side: "new",
    });

    expect(calls).toEqual([
      { line: "beta", sourceLineNumber: 1 },
      { line: "gamma", sourceLineNumber: 2 },
    ]);

    const inserted = result[1];
    if (!inserted || inserted.type !== "stack-line") {
      throw new Error("expected stack-line context row");
    }
    expect(inserted.cell.spans).toEqual([{ text: "highlighted:beta", fg: "#abcdef" }]);
  });

  test("shows an error row when loaded source is shorter than the collapsed range", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [1, 3], [1, 3]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "stack",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "loaded", text: "alpha\n" },
      side: "new",
    });

    expect(result.map((row) => row.type)).toEqual(["collapsed", "hunk-header"]);
    const collapsed = result[0];
    if (!collapsed || collapsed.type !== "collapsed") {
      throw new Error("expected first row to be collapsed");
    }
    expect(collapsed.text.toLowerCase()).toContain("could not load");
    expect(collapsed.text.toLowerCase()).not.toContain("hide");
  });

  test("shows an error row when old-side split expansion is out of bounds", () => {
    const rows: DiffRow[] = [makeCollapsedRow("before", 0, [2, 3], [10, 11]), makeHunkHeader(0)];

    const result = expandCollapsedRows(rows, {
      layout: "split",
      expandedKeys: new Set([reviewGapId("before", 0)]),
      sourceStatus: { kind: "loaded", text: "alpha\n" },
      side: "old",
    });

    expect(result.map((row) => row.type)).toEqual(["collapsed", "hunk-header"]);
    const collapsed = result[0];
    if (!collapsed || collapsed.type !== "collapsed") {
      throw new Error("expected first row to be collapsed");
    }
    expect(collapsed.text.toLowerCase()).toContain("could not load");
  });
});
