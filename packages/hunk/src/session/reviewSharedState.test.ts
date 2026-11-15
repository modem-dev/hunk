import { describe, expect, test } from "bun:test";
import { MAX_REVIEW_NOTE_BYTES } from "../core/review/noteSize";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "./reviewProtocol";
import {
  parseReviewSharedState,
  parseReviewSharedStateResourceId,
  REVIEW_SHARED_STATE_CURRENT_RESOURCE_ID,
  reviewSharedStateResourceId,
  type ReviewSharedStateV1,
} from "./reviewSharedState";

/** One hand-written snapshot exercising every optional block. */
function createTestSharedState(): ReviewSharedStateV1 {
  return {
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    generation: "generation:p1:2",
    stateRevision: 9,
    sharedStateRevision: 4,
    files: [
      {
        key: "file:aa",
        path: "src/a.ts",
        previousPath: "src/old.ts",
        changeKind: "rename-changed",
        language: "typescript",
        stats: { additions: 2, deletions: 1, truncated: false },
        flags: { untracked: false, binary: false, tooLarge: false, partial: false },
        splitLineCount: 10,
        unifiedLineCount: 12,
        contentIdentity: "content:1",
        agentSummary: "Renamed and tightened.",
      },
    ],
    notes: [
      {
        note: {
          id: "mcp:1",
          source: "agent",
          fileKey: "file:aa",
          anchor: {
            newRange: [3, 3],
            preferred: { side: "new", line: 3 },
            intersectingHunkIndices: [0],
            ownerHunkIndex: 0,
          },
          summary: "Check this.",
          editable: false,
        },
        resolution: "active",
        origin: "live",
      },
    ],
    filter: "a.ts",
    showAgentNotes: true,
    agentHighlights: { "file:aa": [{ side: "new", line: 3, start: 0, end: 4, tone: "warning" }] },
    agentReveal: { token: 2, fileKey: "file:aa", hunkIndex: 0, side: "new", line: 3 },
    presentation: {
      title: "working tree",
      sourceLabel: "/repo",
      theme: {
        kind: "custom",
        id: "mine",
        label: "Mine",
        appearance: "dark",
        tokens: { background: "#000000" },
        syntaxColors: { keyword: "#ff0000" },
      },
      view: { layout: "auto", wrapLines: false, lineNumbers: true, hunkHeaders: true },
      keymap: { "hunk.app.quit": ["q"] },
    },
  };
}

describe("parseReviewSharedState", () => {
  test("accepts a complete snapshot unchanged", () => {
    const state = createTestSharedState();
    expect(parseReviewSharedState(structuredClone(state))).toEqual(state);
  });

  test("refuses extra keys, another protocol version, and keys missing from the file index", () => {
    expect(parseReviewSharedState({ ...createTestSharedState(), selection: {} })).toBeUndefined();
    expect(
      parseReviewSharedState({ ...createTestSharedState(), protocolVersion: 99 }),
    ).toBeUndefined();

    const orphanNote = createTestSharedState();
    orphanNote.notes[0]!.note.fileKey = "file:bb";
    expect(parseReviewSharedState(orphanNote)).toBeUndefined();

    const orphanMark = createTestSharedState();
    orphanMark.agentHighlights = { "file:bb": orphanMark.agentHighlights["file:aa"]! };
    expect(parseReviewSharedState(orphanMark)).toBeUndefined();
  });

  test("refuses malformed marks, reveals, and notes over the shared size bound", () => {
    const emptyMarks = createTestSharedState();
    emptyMarks.agentHighlights = { "file:aa": [] };
    expect(parseReviewSharedState(emptyMarks)).toBeUndefined();

    const backwardsMark = createTestSharedState();
    backwardsMark.agentHighlights["file:aa"]![0]!.end = 0;
    expect(parseReviewSharedState(backwardsMark)).toBeUndefined();

    const halfLine = createTestSharedState();
    halfLine.agentReveal = { token: 1, fileKey: "file:aa", hunkIndex: 0, side: "new" };
    expect(parseReviewSharedState(halfLine)).toBeUndefined();

    const zeroToken = createTestSharedState();
    zeroToken.agentReveal = { token: 0, fileKey: "file:aa", hunkIndex: 0 };
    expect(parseReviewSharedState(zeroToken)).toBeUndefined();

    const huge = createTestSharedState();
    huge.notes[0]!.note.summary = "x".repeat(MAX_REVIEW_NOTE_BYTES + 1);
    expect(parseReviewSharedState(huge)).toBeUndefined();

    const orphaned = createTestSharedState();
    (orphaned.notes[0] as { resolution: string }).resolution = "orphaned";
    expect(parseReviewSharedState(orphaned)).toBeUndefined();
  });

  test("accepts a built-in theme only by id", () => {
    const builtin = createTestSharedState();
    builtin.presentation.theme = { kind: "builtin", id: "github-dark-default", appearance: "dark" };
    expect(parseReviewSharedState(builtin)).toEqual(builtin);
    (builtin.presentation.theme as Record<string, unknown>).tokens = {};
    expect(parseReviewSharedState(builtin)).toBeUndefined();
  });
});

describe("shared-state resource ids", () => {
  test("round-trip a revision and the current alias, and refuse anything else", () => {
    expect(parseReviewSharedStateResourceId(reviewSharedStateResourceId(12))).toBe(12);
    expect(parseReviewSharedStateResourceId(REVIEW_SHARED_STATE_CURRENT_RESOURCE_ID)).toBe(
      "current",
    );
    expect(parseReviewSharedStateResourceId("state:01")).toBeUndefined();
    expect(parseReviewSharedStateResourceId("state:-1")).toBeUndefined();
    expect(parseReviewSharedStateResourceId("resource:patch:file:aa")).toBeUndefined();
  });
});
