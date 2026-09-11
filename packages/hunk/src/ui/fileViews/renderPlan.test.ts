import { describe, expect, test } from "bun:test";
import type { ExtensionFileViewLayout } from "../../extension-api/types";
import { createVisibleAgentNote, type VisibleAgentNote } from "../lib/agentAnnotations";
import { validateFileViewLayout } from "./layout";
import { buildFileViewRenderPlan } from "./renderPlan";

const layout: ExtensionFileViewLayout = {
  rows: [
    {
      id: "old-summary",
      spans: [{ text: "old" }],
      sourceRanges: [{ side: "old", range: [2, 4] }],
    },
    {
      id: "new-summary",
      spans: [{ text: "new" }],
      sourceRanges: [{ side: "new", range: [5, 8] }],
    },
  ],
  hunkRows: [{ startRow: 0, endRow: 1 }],
};

/** Build the minimal host note payload used by alternate-view planning. */
function note(
  id: string,
  ranges: { oldRange?: [number, number]; newRange?: [number, number] },
): VisibleAgentNote {
  return createVisibleAgentNote([], {
    id,
    annotation: { id, summary: id, ...ranges },
  });
}

describe("file-view render plan", () => {
  test("inserts notes after the uniquely bound preferred-side row", () => {
    const plan = buildFileViewRenderPlan(layout, [
      note("both", { oldRange: [3, 3], newRange: [6, 7] }),
    ]);

    expect(plan.unresolvedNoteIds).toEqual([]);
    expect(plan.rows.map((row) => `${row.kind}:${row.key}`)).toEqual([
      "file-view-row:file-view:old-summary",
      "file-view-row:file-view:new-summary",
      "inline-note:inline-note:both:file-view:new-summary:0",
    ]);
    expect(plan.rows[2]).toMatchObject({
      kind: "inline-note",
      anchorRowIndex: 1,
      anchorSide: "new",
      hunkIndex: 0,
    });
  });

  test("anchors each row on the source line the raw diff addresses", () => {
    const plan = buildFileViewRenderPlan(layout, []);

    expect(
      plan.rows.map((row) => (row.kind === "file-view-row" ? row.stableAliasKeys : [])),
    ).toEqual([["line:0:old:2"], ["line:0:new:5"]]);
  });

  test("gives one source line to the first row that presents it", () => {
    const repeated: ExtensionFileViewLayout = {
      rows: [
        {
          id: "first",
          spans: [{ text: "a" }],
          sourceRanges: [{ side: "new", range: [5, 5] }],
        },
        {
          id: "second",
          spans: [{ text: "b" }],
          sourceRanges: [{ side: "new", range: [5, 5] }],
        },
      ],
      hunkRows: [{ startRow: 0, endRow: 1 }],
    };
    const plan = buildFileViewRenderPlan(repeated, []);

    expect(
      plan.rows.map((row) => (row.kind === "file-view-row" ? row.stableAliasKeys : [])),
    ).toEqual([["line:0:new:5"], undefined]);
  });

  test("leaves rows outside one hunk unaddressable by line navigation", () => {
    const spanningHunks: ExtensionFileViewLayout = {
      ...layout,
      hunkRows: [
        { startRow: 0, endRow: 1 },
        { startRow: 0, endRow: 1 },
      ],
    };
    const plan = buildFileViewRenderPlan(spanningHunks, []);

    expect(plan.rows.every((row) => row.kind !== "file-view-row" || !row.stableAliasKeys)).toBe(
      true,
    );
  });

  test("groups notes at one anchor in stable input order", () => {
    const plan = buildFileViewRenderPlan(layout, [
      note("first", { newRange: [5, 5] }),
      note("second", { newRange: [8, 8] }),
    ]);
    const notes = plan.rows.filter((row) => row.kind === "inline-note");

    expect(notes.map((row) => row.note.id)).toEqual(["first", "second"]);
    expect(notes.map((row) => [row.noteIndex, row.noteCount])).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  test("keeps note ownership and navigation identical when code documents are declared", () => {
    const oldLines = ["outside 😀", "const\t界 = 'old long value';", "oldCell"];
    const newLines = ["outside 😀", "const\t界 = 'new long value';", "newCell"];
    const rows: ExtensionFileViewLayout["rows"] = [
      { id: "outside", spans: [{ text: oldLines[0]! }] },
      {
        id: "old-code",
        spans: [{ text: oldLines[1]! }],
        sourceRanges: [{ side: "old", range: [2, 2] }],
      },
      {
        id: "split-code",
        spans: [{ text: oldLines[2]! }, { text: " | " }, { text: newLines[2]! }],
        sourceRanges: [{ side: "new", range: [3, 3] }],
      },
      {
        id: "long-code",
        spans: [{ text: "é界 long wrapping words long wrapping words" }],
        sourceRanges: [{ side: "new", range: [20, 20] }],
      },
    ];
    const plain: ExtensionFileViewLayout = {
      rows,
      hunkRows: [
        { startRow: 1, endRow: 2 },
        { startRow: 3, endRow: 3 },
      ],
    };
    const syntax: ExtensionFileViewLayout = {
      codeDocuments: [
        { id: "old", text: oldLines.join("\n"), language: "typescript" },
        {
          id: "new",
          text: `${newLines.join("\n")}\né界 long wrapping words long wrapping words`,
          language: "typescript",
        },
      ],
      rows: [
        {
          ...rows[0]!,
          spans: [{ text: oldLines[0]!, syntax: { documentId: "old", line: 1 } }],
        },
        {
          ...rows[1]!,
          spans: [{ text: oldLines[1]!, syntax: { documentId: "old", line: 2 } }],
        },
        {
          ...rows[2]!,
          spans: [
            { text: oldLines[2]!, syntax: { documentId: "old", line: 3 } },
            { text: " | " },
            { text: newLines[2]!, syntax: { documentId: "new", line: 3 } },
          ],
        },
        {
          ...rows[3]!,
          spans: [
            {
              text: "é界 long wrapping words long wrapping words",
              syntax: { documentId: "new", line: 4 },
            },
          ],
        },
      ],
      hunkRows: plain.hunkRows,
    };
    const checked = [plain, syntax].map((candidate) => {
      const result = validateFileViewLayout(candidate, 2, 9);
      if (!result.valid) throw new Error(result.issue);
      return result.value.layout;
    });
    const notes = [
      note("bound", { newRange: [3, 3] }),
      note("unresolved", { newRange: [999, 999] }),
    ];
    const plans = checked.map((candidate) => buildFileViewRenderPlan(candidate, notes));
    const summarize = (plan: (typeof plans)[number]) => ({
      unresolvedNoteIds: plan.unresolvedNoteIds,
      rows: plan.rows.map((row) =>
        row.kind === "file-view-row"
          ? {
              kind: row.kind,
              key: row.key,
              stableKey: row.stableKey,
              stableAliasKeys: row.stableAliasKeys,
              rowIndex: row.rowIndex,
            }
          : {
              kind: row.kind,
              key: row.key,
              stableKey: row.stableKey,
              anchorRowIndex: row.anchorRowIndex,
              anchorSide: row.anchorSide,
              hunkIndex: row.hunkIndex,
            },
      ),
    });

    expect(summarize(plans[1]!)).toEqual(summarize(plans[0]!));
    expect(plans[1]!.unresolvedNoteIds).toEqual(["unresolved"]);
    expect(plans[1]!.rows[0]?.kind).toBe("file-view-row");
    expect(
      plans[1]!.rows[0]?.kind === "file-view-row"
        ? plans[1]!.rows[0].stableAliasKeys
        : "unexpected note",
    ).toBeUndefined();
    expect(plans[1]!.rows.map((row) => row.stableKey)).toEqual([
      "file-view:outside",
      "file-view:old-code",
      "file-view:split-code",
      "inline-note:bound",
      "file-view:long-code",
    ]);
  });

  test("reports every range-less, unbound, or out-of-hunk note instead of guessing", () => {
    const outsideHunk: ExtensionFileViewLayout = {
      ...layout,
      hunkRows: [{ startRow: 0, endRow: 0 }],
    };
    const plan = buildFileViewRenderPlan(outsideHunk, [
      note("range-less", {}),
      note("unbound", { newRange: [20, 20] }),
      note("outside-hunk", { newRange: [6, 6] }),
    ]);

    expect(plan.unresolvedNoteIds).toEqual(["range-less", "unbound", "outside-hunk"]);
    expect(plan.rows.every((row) => row.kind === "file-view-row")).toBe(true);

    const overlappingHunks = buildFileViewRenderPlan(
      {
        ...layout,
        hunkRows: [
          { startRow: 0, endRow: 1 },
          { startRow: 1, endRow: 1 },
        ],
      },
      [note("ambiguous-hunk", { newRange: [6, 6] })],
    );
    expect(overlappingHunks.unresolvedNoteIds).toEqual(["ambiguous-hunk"]);
  });
});
