import { describe, expect, test } from "bun:test";
import { validateFileViewLayout, validateFileViewSourceRanges } from "./layout";

describe("file-view layout validation", () => {
  test("accepts deterministic symbolic rows and measures terminal-width wrapping", () => {
    const result = validateFileViewLayout(
      {
        rows: [
          {
            id: "heading",
            spans: [{ text: "# title", tone: "accent", attributes: ["bold"] }],
          },
          { id: "wide", spans: [{ text: "界界" }] },
        ],
        hunkRows: [{ startRow: 0, endRow: 1 }],
      },
      1,
      3,
    );

    expect(result).toMatchObject({ valid: true });
    if (result.valid) expect(result.value.rowHeights).toEqual([3, 2]);
  });

  test("returns a deeply immutable host snapshot detached from extension mutation", () => {
    const firstRender = () => "first";
    const secondRender = () => "second";
    const attributes = ["bold"] as ("bold" | "italic")[];
    const span: {
      text: string;
      tone: "accent" | "removed";
      attributes: ("bold" | "italic")[];
    } = { text: "original", tone: "accent", attributes };
    const component = { height: 2, render: firstRender };
    const sourceRange = { side: "new" as const, range: [1, 2] };
    const row = { id: "original-row", spans: [span], sourceRanges: [sourceRange], component };
    const hunk = { startRow: 0, endRow: 0 };
    const source = { rows: [row], hunkRows: [hunk] };

    const result = validateFileViewLayout(source, 1, 80);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    row.id = "mutated-row";
    span.text = "mutated";
    span.tone = "removed";
    attributes[0] = "italic";
    component.height = 9;
    component.render = secondRender;
    sourceRange.range[0] = 99;
    hunk.startRow = 99;
    source.rows.length = 0;
    source.hunkRows.length = 0;

    expect(result.value).toEqual({
      layout: {
        rows: [
          {
            id: "original-row",
            spans: [{ text: "original", tone: "accent", attributes: ["bold"] }],
            sourceRanges: [{ side: "new", range: [1, 2] }],
            component: { height: 2, render: firstRender },
          },
        ],
        hunkRows: [{ startRow: 0, endRow: 0 }],
      },
      rowHeights: [2],
    });
    expect(
      [
        result.value,
        result.value.layout,
        result.value.layout.rows,
        result.value.layout.rows[0],
        result.value.layout.rows[0]?.spans,
        result.value.layout.rows[0]?.spans[0],
        result.value.layout.rows[0]?.spans[0]?.attributes,
        result.value.layout.rows[0]?.sourceRanges,
        result.value.layout.rows[0]?.sourceRanges?.[0],
        result.value.layout.rows[0]?.sourceRanges?.[0]?.range,
        result.value.layout.rows[0]?.component,
        result.value.layout.hunkRows,
        result.value.layout.hunkRows[0],
        result.value.rowHeights,
      ].every(Object.isFrozen),
    ).toBe(true);
  });

  test("validates exact source bindings and rejects ambiguous mappings", () => {
    const valid = validateFileViewLayout(
      {
        rows: [
          { id: "old", spans: [], sourceRanges: [{ side: "old", range: [1, 2] }] },
          { id: "new", spans: [], sourceRanges: [{ side: "new", range: [2, 3] }] },
        ],
        hunkRows: [{ startRow: 0, endRow: 1 }],
      },
      1,
      80,
    );
    expect(valid).toMatchObject({ valid: true });
    if (!valid.valid) return;
    expect(
      validateFileViewSourceRanges(valid.value.layout, { old: "a\nb\n", new: "a\nb\nc" }),
    ).toBeNull();
    // Unreadable source and a wrong binding are reported as different kinds so the host can
    // attribute an environment condition separately from an extension mistake.
    expect(validateFileViewSourceRanges(valid.value.layout, { old: "a\nb\n", new: null })).toEqual({
      kind: "unavailable-source",
      detail: "rows[1].sourceRanges[0] targets unavailable new source",
    });
    expect(
      validateFileViewSourceRanges(valid.value.layout, { old: "a\n", new: "a\nb\nc" }),
    ).toEqual({
      kind: "out-of-bounds",
      detail: "rows[0].sourceRanges[0] exceeds the old source bounds",
    });

    expect(
      validateFileViewLayout(
        {
          rows: [
            {
              id: "aggregate",
              spans: [],
              sourceRanges: [
                { side: "new", range: [1, 2] },
                { side: "new", range: [2, 3] },
              ],
            },
          ],
          hunkRows: [{ startRow: 0, endRow: 0 }],
        },
        1,
        80,
      ),
    ).toMatchObject({ valid: true });

    expect(
      validateFileViewLayout(
        {
          rows: [
            { id: "one", spans: [], sourceRanges: [{ side: "new", range: [1, 3] }] },
            { id: "two", spans: [], sourceRanges: [{ side: "new", range: [3, 4] }] },
          ],
          hunkRows: [],
        },
        0,
        80,
      ),
    ).toEqual({
      valid: false,
      issue: "new-side source ranges overlap between rows[0] and rows[1]",
    });
    expect(
      validateFileViewLayout(
        {
          rows: [{ id: "shared", spans: [], sourceRanges: [{ side: "new", range: [1, 1] }] }],
          hunkRows: [
            { startRow: 0, endRow: 0 },
            { startRow: 0, endRow: 0 },
          ],
        },
        2,
        80,
      ),
    ).toEqual({
      valid: false,
      issue: "rows[0].sourceRanges must belong to exactly one hunkRows range",
    });

    expect(
      validateFileViewLayout(
        {
          rows: [{ id: "bad", spans: [], sourceRanges: [{ side: "new", range: [0, 1] }] }],
          hunkRows: [],
        },
        0,
        80,
      ),
    ).toEqual({
      valid: false,
      issue: "rows[0].sourceRanges[0] is not a valid one-based source range",
    });
  });

  test("validates the maximum source-range count against each document once", () => {
    const sourceRanges = Array.from({ length: 40_000 }, () => ({
      side: "new" as const,
      range: [1, 1] as const,
    }));
    const result = validateFileViewLayout(
      {
        rows: [{ id: "aggregate", spans: [], sourceRanges }],
        hunkRows: [{ startRow: 0, endRow: 0 }],
      },
      1,
      80,
    );
    expect(result).toMatchObject({ valid: true });
    if (result.valid) {
      expect(validateFileViewSourceRanges(result.value.layout, { new: "line\n" })).toBeNull();
    }
  });

  test("accepts bounded custom row painters with an atomic fixed-height descriptor", () => {
    const render = () => null;
    const result = validateFileViewLayout(
      {
        rows: [
          {
            id: "custom",
            spans: [{ text: "fallback" }],
            component: { height: 4, render },
          },
        ],
        hunkRows: [{ startRow: 0, endRow: 0 }],
      },
      1,
      80,
    );

    expect(result).toMatchObject({ valid: true });
    if (result.valid) {
      expect(result.value.rowHeights).toEqual([4]);
      expect(result.value.layout.rows[0]?.component?.render).toBe(render);
    }
  });

  test("rejects invalid and resource-heavy custom row descriptors", () => {
    expect(
      validateFileViewLayout(
        {
          rows: [{ id: "invalid", spans: [], component: "not an object" }],
          hunkRows: [],
        },
        0,
        80,
      ),
    ).toEqual({ valid: false, issue: "rows[0].component is not an object" });

    expect(
      validateFileViewLayout(
        {
          rows: [
            {
              id: "invalid",
              spans: [],
              component: { height: 2, render: "nope" },
            },
          ],
          hunkRows: [],
        },
        0,
        80,
      ),
    ).toEqual({
      valid: false,
      issue: "rows[0].component.render is not a function",
    });

    expect(
      validateFileViewLayout(
        {
          rows: [
            {
              id: "tall",
              spans: [],
              component: { height: 257, render: () => null },
            },
          ],
          hunkRows: [],
        },
        0,
        80,
      ),
    ).toEqual({
      valid: false,
      issue: "rows[0].component.height must be an integer from 1 to 256",
    });

    const rows = Array.from({ length: 391 }, (_, index) => ({
      id: `row-${index}`,
      spans: [],
      component: { height: 256, render: () => null },
    }));
    expect(validateFileViewLayout({ rows, hunkRows: [] }, 0, 80)).toEqual({
      valid: false,
      issue: "layout exceeds 100000 terminal rows",
    });

    const symbolicRows = Array.from({ length: 10_000 }, (_, index) => ({
      id: `symbolic-${index}`,
      spans: [{ text: "xxxxxxxxxxx" }],
    }));
    expect(validateFileViewLayout({ rows: symbolicRows, hunkRows: [] }, 0, 1)).toEqual({
      valid: false,
      issue: "layout exceeds 100000 terminal rows",
    });
  });

  test("rejects layouts that cannot supply positional host-owned hunk geometry", () => {
    const result = validateFileViewLayout(
      {
        rows: [{ id: "one", spans: [{ text: "one" }] }],
        hunkRows: [{ startRow: 0, endRow: 0 }],
      },
      2,
      80,
    );

    expect(result).toEqual({
      valid: false,
      issue: "layout has 1 hunk bounds for 2 hunks",
    });
  });

  test("rejects duplicate row ids and non-generic presentation values", () => {
    const duplicate = validateFileViewLayout(
      {
        rows: [
          { id: "same", spans: [{ text: "one" }] },
          { id: "same", spans: [{ text: "two" }] },
        ],
        hunkRows: [],
      },
      0,
      80,
    );
    expect(duplicate).toMatchObject({
      valid: false,
      issue: 'rows[1] repeats id "same"',
    });

    for (const tone of ["heading", "text"]) {
      expect(
        validateFileViewLayout(
          {
            rows: [{ id: "one", spans: [{ text: "one", tone }] }],
            hunkRows: [],
          },
          0,
          80,
        ),
      ).toEqual({
        valid: false,
        issue: "rows[0] contains an invalid span tone",
      });
    }
  });
});
