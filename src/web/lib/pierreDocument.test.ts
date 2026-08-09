import { describe, expect, test } from "bun:test";
import type { ReviewFileV1, ReviewNoteV1 } from "../../core/review/types";
import { pierreNoteAnchor, toPierreReviewFile } from "./pierreDocument";
import type { BrowserReviewDocument, BrowserReviewFile } from "./reviewTypes";

const note: ReviewNoteV1 = {
  id: "note:1",
  source: "agent",
  origin: "live-agent",
  originalSource: "mcp",
  fileKey: "file:1",
  anchor: {
    oldRange: [1, 1],
    newRange: [1, 1],
    preferred: { side: "new", line: 1 },
    intersectingHunkIndices: [0],
    ownerHunkIndex: 0,
  },
  summary: "Use the normalized anchor",
  rationale: "The browser must not derive ownership.",
  markup: "<strong>safe</strong>",
  editable: false,
};
const canonical: ReviewFileV1 = {
  key: "file:1",
  runtimeId: "runtime:1",
  path: "src/new.ts",
  previousPath: "src/old.ts",
  changeKind: "rename-changed",
  language: "typescript",
  agentSummary: "needle summary",
  stats: { additions: 1, deletions: 1, truncated: false },
  flags: { untracked: false, binary: false, tooLarge: false, partial: true },
  patchResourceId: "patch:1",
  canonicalResourceId: "canonical:1",
  sourceResourceIds: { new: "source:1" },
  additionLines: ["new"],
  deletionLines: ["old"],
  lineMoveKinds: { additionLines: ["moved"], deletionLines: ["moved"] },
  hunks: [
    {
      index: 0,
      collapsedBefore: 0,
      splitLineCount: 1,
      splitLineStart: 0,
      unifiedLineCount: 2,
      unifiedLineStart: 0,
      additionCount: 1,
      additionStart: 1,
      additionLines: 1,
      deletionCount: 1,
      deletionStart: 1,
      deletionLines: 1,
      deletionLineIndex: 0,
      additionLineIndex: 0,
      hunkContent: [
        { type: "change", additions: 1, deletions: 1, additionLineIndex: 0, deletionLineIndex: 0 },
      ],
      hunkSpecs: "@@ -1 +1 @@",
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
    },
  ],
  notes: [note],
  expandedContext: [
    {
      gapId: "gap:1",
      side: "new",
      oldRange: [2, 2],
      newRange: [2, 2],
      sourceResourceId: "source:1",
    },
  ],
};
const file: BrowserReviewFile = {
  key: canonical.key,
  runtimeId: canonical.runtimeId,
  path: canonical.path,
  previousPath: canonical.previousPath,
  changeKind: canonical.changeKind,
  language: canonical.language,
  agentSummary: canonical.agentSummary,
  additions: 1,
  deletions: 1,
  statsTruncated: false,
  hunkCount: 1,
  flags: canonical.flags,
  patchResourceId: canonical.patchResourceId,
  canonicalResourceId: canonical.canonicalResourceId,
  sourceResourceIds: canonical.sourceResourceIds,
  hunks: [{ index: 0, header: "@@ -1 +1 @@", oldRange: [1, 1], newRange: [1, 1] }],
  notes: [note],
};
const canonicalText = JSON.stringify(canonical);
const document: BrowserReviewDocument = {
  version: 1,
  generation: "generation:test",
  documentIdentity: "document:test",
  changesetId: "changeset:test",
  title: "Review",
  sourceLabel: "test",
  files: [file],
  resources: [
    {
      id: "canonical:1",
      kind: "canonical-file",
      generation: "generation:test",
      fileKey: "file:1",
      contentType: "application/vnd.hunk.review-file+json; charset=utf-8",
      byteLength: new TextEncoder().encode(canonicalText).byteLength,
      digest: "0".repeat(64),
    },
  ],
  capabilities: { actions: [] },
};

function canonicalWithSides(
  changeKind: ReviewFileV1["changeKind"],
  oldStart: number,
  newStart: number,
  contextOnly = false,
): ReviewFileV1 {
  const deletionLineCount = oldStart > 0 ? (contextOnly ? 2 : 1) : 0;
  const additionLineCount = newStart > 0 ? (contextOnly ? 2 : 1) : 0;
  return {
    ...canonical,
    changeKind,
    deletionLines: Array.from({ length: deletionLineCount }, () => "old"),
    additionLines: Array.from({ length: additionLineCount }, () => "new"),
    hunks: [
      {
        ...canonical.hunks[0]!,
        deletionStart: oldStart,
        deletionLines: deletionLineCount,
        deletionCount: contextOnly ? 0 : deletionLineCount,
        additionStart: newStart,
        additionLines: additionLineCount,
        additionCount: contextOnly ? 0 : additionLineCount,
        hunkContent: contextOnly
          ? [{ type: "context", lines: 2, deletionLineIndex: 0, additionLineIndex: 0 }]
          : [
              {
                type: "change",
                deletions: deletionLineCount,
                additions: additionLineCount,
                deletionLineIndex: 0,
                additionLineIndex: 0,
              },
            ],
      },
    ],
  };
}

function manifestWithSides(
  changeKind: BrowserReviewFile["changeKind"],
  oldRange: [number, number] | undefined,
  newRange: [number, number] | undefined,
): BrowserReviewFile {
  return {
    ...file,
    changeKind,
    hunks: [{ ...file.hunks[0]!, oldRange, newRange }],
  };
}

describe("browser document to Pierre adapter", () => {
  test("uses canonical projected lines/hunks/moves/context without reparsing VCS semantics", () => {
    const result = toPierreReviewFile(document, file, canonicalText);
    expect(result.fileDiff.name).toBe("src/new.ts");
    expect(result.fileDiff.additionLines).toEqual(["new"]);
    expect(result.annotations).toEqual([{ side: "additions", lineNumber: 1, metadata: note }]);
    expect(result.movedLines?.additionLines).toEqual(["moved"]);
    expect(result.expandedContext).toEqual(canonical.expandedContext);
    expect(result.agentSummary).toBe("needle summary");
  });
  test("uses the full preferred range when its start precedes the owner hunk", () => {
    const partial = {
      ...note,
      anchor: {
        ...note.anchor,
        newRange: [0, 1] as [number, number],
        preferred: { side: "new" as const, line: 0 },
      },
    };
    expect(pierreNoteAnchor(file, partial, canonical)).toEqual({
      side: "additions",
      lineNumber: 1,
    });
  });

  test("falls unmatched old-side and range-less notes back to an added hunk's first line", () => {
    const addedCanonical = canonicalWithSides("new", 0, 3);
    const addedFile = manifestWithSides("new", undefined, [3, 3]);
    const unmatchedOld = {
      ...note,
      anchor: {
        oldRange: [50, 51] as [number, number],
        preferred: { side: "old" as const, line: 50 },
        intersectingHunkIndices: [],
        ownerHunkIndex: 0,
      },
    };
    const rangeLess = { ...note, anchor: { intersectingHunkIndices: [], ownerHunkIndex: 0 } };

    expect(pierreNoteAnchor(addedFile, unmatchedOld, addedCanonical)).toEqual({
      side: "additions",
      lineNumber: 3,
    });
    expect(pierreNoteAnchor(addedFile, rangeLess, addedCanonical)).toEqual({
      side: "additions",
      lineNumber: 3,
    });
  });

  test("falls unmatched new-side and range-less notes back to a deleted hunk's first line", () => {
    const deletedCanonical = canonicalWithSides("deleted", 7, 0);
    const deletedFile = manifestWithSides("deleted", [7, 7], undefined);
    const unmatchedNew = {
      ...note,
      anchor: {
        newRange: [50, 51] as [number, number],
        preferred: { side: "new" as const, line: 50 },
        intersectingHunkIndices: [],
        ownerHunkIndex: 0,
      },
    };
    const rangeLess = { ...note, anchor: { intersectingHunkIndices: [], ownerHunkIndex: 0 } };

    expect(pierreNoteAnchor(deletedFile, unmatchedNew, deletedCanonical)).toEqual({
      side: "deletions",
      lineNumber: 7,
    });
    expect(pierreNoteAnchor(deletedFile, rangeLess, deletedCanonical)).toEqual({
      side: "deletions",
      lineNumber: 7,
    });
  });

  test("uses valid sides for unmatched and dual partial notes in a context-only hunk", () => {
    const contextCanonical = canonicalWithSides("change", 10, 20, true);
    const contextFile = manifestWithSides("change", [10, 11], [20, 21]);
    const unmatchedOld = {
      ...note,
      anchor: {
        oldRange: [99, 100] as [number, number],
        preferred: { side: "old" as const, line: 99 },
        intersectingHunkIndices: [],
        ownerHunkIndex: 0,
      },
    };
    const dualPartial = {
      ...note,
      anchor: {
        oldRange: [10, 10] as [number, number],
        newRange: [19, 20] as [number, number],
        preferred: { side: "new" as const, line: 19 },
        intersectingHunkIndices: [0],
        ownerHunkIndex: 0,
      },
    };

    expect(pierreNoteAnchor(contextFile, unmatchedOld, contextCanonical)).toEqual({
      side: "deletions",
      lineNumber: 10,
    });
    expect(pierreNoteAnchor(contextFile, dualPartial, contextCanonical)).toEqual({
      side: "additions",
      lineNumber: 20,
    });
  });
});
