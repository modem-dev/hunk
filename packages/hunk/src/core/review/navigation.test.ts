import { describe, expect, test } from "bun:test";
import {
  EMPTY_REVIEW_ANNOTATION_INDEX,
  planReviewNoteMove,
  planReviewSelectionMove,
  REVIEW_SELECTION_WRAP_POLICY,
  reviewAnnotatedCursors,
  reviewChangeBlockCursors,
  reviewStreamCursors,
  type ReviewAnnotationIndex,
  type ReviewChangeBlockCursor,
  type ReviewNavigationFile,
  type ReviewNavigationModel,
  type ReviewSelectionScope,
  type ReviewThreadCursor,
} from "./navigation";
import type { ReviewSemanticSelection } from "./state";
import type { ReviewLineAddressV1 } from "./types";

/** Three files of two hunks each: alpha, beta, gamma. */
const FILES: ReviewNavigationFile[] = [
  { fileKey: "alpha", hunkCount: 2 },
  { fileKey: "beta", hunkCount: 2 },
  { fileKey: "gamma", hunkCount: 2 },
];

/** Build an annotation index from hunk membership, plus the files those hunks live in. */
function annotationIndex(
  membership: Record<string, number[]>,
  extraFileKeys: string[] = [],
): ReviewAnnotationIndex {
  return {
    annotatedHunkIndicesByFileKey: new Map(
      Object.entries(membership).map(([fileKey, hunks]) => [fileKey, new Set(hunks)]),
    ),
    annotatedFileKeys: new Set([...Object.keys(membership), ...extraFileKeys]),
  };
}

function model(annotations = EMPTY_REVIEW_ANNOTATION_INDEX): ReviewNavigationModel {
  return { files: FILES, annotations };
}

function at(fileKey: string | null, hunkIndex: number): ReviewSemanticSelection {
  return { fileKey, hunkIndex };
}

/** Move and report the landing position plus what it asked the viewport to reveal. */
function move(
  navigationModel: ReviewNavigationModel,
  selection: ReviewSemanticSelection,
  scope: ReviewSelectionScope,
  delta: number,
) {
  const target = planReviewSelectionMove(navigationModel, selection, { scope, delta });
  return target
    ? { at: `${target.fileKey}:${target.hunkIndex}`, reveal: target.reveal }
    : { at: null };
}

describe("review selection movement", () => {
  // Intent: the wrap policy is a named per-scope decision, not arithmetic that happens to differ.
  test("declares one wrap policy per scope", () => {
    expect(REVIEW_SELECTION_WRAP_POLICY).toEqual({
      hunk: "clamp",
      file: "clamp",
      note: "clamp",
      "annotated-hunk": "clamp",
      "annotated-file": "wrap",
      "change-block": "clamp",
      "comment-thread": "clamp",
    });
  });

  test("flattens the stream and its annotated subset in review order", () => {
    expect(reviewStreamCursors(FILES)).toEqual([
      { fileKey: "alpha", hunkIndex: 0 },
      { fileKey: "alpha", hunkIndex: 1 },
      { fileKey: "beta", hunkIndex: 0 },
      { fileKey: "beta", hunkIndex: 1 },
      { fileKey: "gamma", hunkIndex: 0 },
      { fileKey: "gamma", hunkIndex: 1 },
    ]);
    expect(reviewAnnotatedCursors(FILES, annotationIndex({ alpha: [1], gamma: [0] }))).toEqual([
      { fileKey: "alpha", hunkIndex: 1 },
      { fileKey: "gamma", hunkIndex: 0 },
    ]);
  });

  test("steps hunks across file boundaries and clamps at both ends", () => {
    expect(move(model(), at("alpha", 1), "hunk", 1).at).toBe("beta:0");
    expect(move(model(), at("beta", 0), "hunk", -1).at).toBe("alpha:1");
    expect(move(model(), at("alpha", 0), "hunk", 3).at).toBe("beta:1");
    // Clamping, not wrapping: the ends of the stream are where hunk navigation stops.
    expect(move(model(), at("gamma", 1), "hunk", 1).at).toBe("gamma:1");
    expect(move(model(), at("alpha", 0), "hunk", -1).at).toBe("alpha:0");
  });

  test("reveals the file header only when a hunk move crosses forward into another file", () => {
    expect(move(model(), at("alpha", 1), "hunk", 1).reveal).toEqual({
      anchor: "file-top",
      scrollToNote: false,
    });
    expect(move(model(), at("beta", 0), "hunk", -1).reveal).toEqual({
      anchor: "hunk",
      scrollToNote: false,
    });
    expect(move(model(), at("alpha", 0), "hunk", 1).reveal).toEqual({
      anchor: "hunk",
      scrollToNote: false,
    });
  });

  test("moves exact notes in order and refuses to reselect at an edge", () => {
    const notes = [
      { noteId: "one", fileKey: "alpha", hunkIndex: 0 },
      { noteId: "two", fileKey: "alpha", hunkIndex: 0 },
      { noteId: "three", fileKey: "beta", hunkIndex: 1 },
    ];

    expect(planReviewNoteMove(FILES, notes, at("alpha", 0), "one", 1)).toEqual({
      fileKey: "alpha",
      hunkIndex: 0,
      activeNoteId: "two",
      reveal: { anchor: "hunk", scrollToNote: true },
    });
    expect(planReviewNoteMove(FILES, notes, at("alpha", 0), "two", 1)?.activeNoteId).toBe("three");
    expect(planReviewNoteMove(FILES, notes, at("beta", 1), "three", 1)).toBeNull();
    expect(planReviewNoteMove(FILES, notes, at("alpha", 0), "one", -1)).toBeNull();
    expect(planReviewNoteMove(FILES, notes, at("beta", 0), undefined, 1)?.activeNoteId).toBe(
      "three",
    );
    expect(planReviewNoteMove(FILES, notes, at("beta", 0), undefined, -1)?.activeNoteId).toBe(
      "two",
    );
    expect(move({ ...model(), notes, activeNoteId: "two" }, at("alpha", 0), "note", 1)).toEqual({
      at: "beta:1",
      reveal: { anchor: "hunk", scrollToNote: true },
    });
  });

  test("steps files onto their first projected hunk and refuses a move that would go nowhere", () => {
    const projectedModel: ReviewNavigationModel = {
      ...model(),
      files: [
        { fileKey: "alpha", hunkCount: 2, hunkIndexes: [1, 3] },
        { fileKey: "beta", hunkCount: 2, hunkIndexes: [2, 4] },
      ],
    };
    expect(move(projectedModel, at("alpha", 1), "file", 1)).toEqual({
      at: "beta:2",
      reveal: { anchor: "file-top", scrollToNote: false },
    });
    expect(move(projectedModel, at("alpha", 1), "hunk", 1)).toEqual({
      at: "alpha:3",
      reveal: { anchor: "hunk", scrollToNote: false },
    });
    expect(move(model(), at("alpha", 0), "file", 2).at).toBe("gamma:0");
    // At an end, file navigation does nothing at all rather than re-revealing the current file.
    expect(move(model(), at("gamma", 1), "file", 1).at).toBeNull();
    expect(move(model(), at("alpha", 0), "file", -1).at).toBeNull();
    // A selection outside the visible stream has nowhere to step from.
    expect(move(model(), at("hidden", 0), "file", 1).at).toBeNull();
  });

  test("carries the remaining steps after reaching the nearest annotated hunk", () => {
    const annotated = model(annotationIndex({ alpha: [0], beta: [1], gamma: [0, 1] }));

    // From an unannotated position, one step reaches the nearest annotated hunk ahead.
    expect(move(annotated, at("alpha", 1), "annotated-hunk", 1).at).toBe("beta:1");
    // Two steps reach it and then take one more, rather than spending both on the approach.
    expect(move(annotated, at("alpha", 1), "annotated-hunk", 2).at).toBe("gamma:0");
    expect(move(annotated, at("alpha", 1), "annotated-hunk", 3).at).toBe("gamma:1");
    // The same rule backwards.
    expect(move(annotated, at("gamma", 0), "annotated-hunk", -1).at).toBe("beta:1");
    expect(move(annotated, at("gamma", 0), "annotated-hunk", -2).at).toBe("alpha:0");
    // Annotated navigation clamps like plain hunk navigation.
    expect(move(annotated, at("alpha", 1), "annotated-hunk", 9).at).toBe("gamma:1");
    expect(move(annotated, at("beta", 0), "annotated-hunk", -9).at).toBe("alpha:0");
  });

  test("asks for the note when annotated-hunk navigation lands", () => {
    const annotated = model(annotationIndex({ beta: [0] }));

    expect(move(annotated, at("alpha", 0), "annotated-hunk", 1).reveal).toEqual({
      anchor: "hunk",
      scrollToNote: true,
    });
  });

  test("refuses annotated navigation when the review has no notes", () => {
    expect(move(model(), at("alpha", 0), "annotated-hunk", 1).at).toBeNull();
    expect(move(model(), at("alpha", 0), "annotated-file", 1).at).toBeNull();
  });

  test("cycles annotated files, wrapping past both ends", () => {
    const annotated = model(annotationIndex({ alpha: [0], gamma: [0] }));

    expect(move(annotated, at("alpha", 0), "annotated-file", 1).at).toBe("gamma:0");
    expect(move(annotated, at("gamma", 0), "annotated-file", 1).at).toBe("alpha:0");
    expect(move(annotated, at("alpha", 0), "annotated-file", -1).at).toBe("gamma:0");
    // Landing on a file shows its content rather than aligning its header.
    expect(move(annotated, at("alpha", 0), "annotated-file", 1).reveal).toEqual({
      anchor: "hunk",
      scrollToNote: false,
    });
  });

  test("treats a file with no notes as the start of the annotated ring", () => {
    const annotated = model(annotationIndex({ alpha: [0], gamma: [0] }));

    // From unannotated beta, "next" is the ring's second entry, exactly as the terminal
    // has always behaved: an absent position normalizes to index 0 before stepping.
    expect(move(annotated, at("beta", 0), "annotated-file", 1).at).toBe("gamma:0");
    expect(move(annotated, at("beta", 0), "annotated-file", -1).at).toBe("gamma:0");
  });

  test("visits a file whose review context lives outside any hunk", () => {
    // A file-level summary with no note inside a hunk: annotated-file navigation stops
    // there, annotated-hunk navigation does not.
    const annotated = model(annotationIndex({ alpha: [0] }, ["beta"]));

    expect(move(annotated, at("alpha", 0), "annotated-file", 1).at).toBe("beta:0");
    expect(move(annotated, at("alpha", 0), "annotated-hunk", 1).at).toBe("alpha:0");
  });

  test("starts from an edge when the current position is not on the stream", () => {
    const annotated = model(annotationIndex({ beta: [0], gamma: [1] }));

    expect(move(model(), at(null, 0), "hunk", 1).at).toBe("alpha:0");
    expect(move(model(), at(null, 0), "hunk", -1).at).toBe("gamma:1");
    expect(move(annotated, at("hidden", 4), "annotated-hunk", 1).at).toBe("beta:0");
    expect(move(annotated, at("hidden", 4), "annotated-hunk", -1).at).toBe("gamma:1");
  });

  test("refuses every move over an empty stream", () => {
    const empty: ReviewNavigationModel = { files: [], annotations: EMPTY_REVIEW_ANNOTATION_INDEX };

    for (const scope of Object.keys(REVIEW_SELECTION_WRAP_POLICY) as ReviewSelectionScope[]) {
      expect(move(empty, at(null, 0), scope, 1).at).toBeNull();
    }
  });
});

/** One change-block cursor; deletion-only when it adds nothing. */
function changeBlock(
  fileKey: string,
  hunkIndex: number,
  blockIndex: number,
  newStart: number,
  additions: number,
  oldStart = newStart,
  deletions = 0,
): ReviewChangeBlockCursor {
  return {
    fileKey,
    hunkIndex,
    blockIndex,
    oldStart,
    deletions,
    newStart,
    additions,
    line: additions > 0 ? { side: "new", line: newStart } : { side: "old", line: oldStart },
  };
}

/** Two blocks in alpha's first hunk, one in its second, and a deletion in beta. */
const CHANGE_BLOCKS = [
  changeBlock("alpha", 0, 0, 3, 2),
  changeBlock("alpha", 0, 1, 10, 1),
  changeBlock("alpha", 1, 0, 30, 1),
  changeBlock("beta", 0, 0, 5, 0, 5, 2),
];

/** Move through change blocks from an optional focus line and report where it landed. */
function moveBlock(
  selection: ReviewSemanticSelection,
  delta: number,
  focus?: { fileKey: string; hunkIndex: number; line?: ReviewLineAddressV1 },
) {
  const target = planReviewSelectionMove(
    { ...model(), changeBlocks: CHANGE_BLOCKS, ...(focus ? { focus } : {}) },
    selection,
    { scope: "change-block", delta },
  );
  return target?.landing?.kind === "change-block"
    ? `${target.fileKey}:${target.hunkIndex}:${target.landing.block.blockIndex}`
    : null;
}

describe("change-block movement", () => {
  const onNew = (fileKey: string, hunkIndex: number, line: number) => ({
    fileKey,
    hunkIndex,
    line: { side: "new" as const, line },
  });

  test("steps blocks inside one hunk, then across hunk and file boundaries", () => {
    expect(moveBlock(at("alpha", 0), 1, onNew("alpha", 0, 4))).toBe("alpha:0:1");
    expect(moveBlock(at("alpha", 0), 2, onNew("alpha", 0, 4))).toBe("alpha:1:0");
    expect(moveBlock(at("alpha", 1), 1, onNew("alpha", 1, 30))).toBe("beta:0:0");
    expect(
      moveBlock(at("beta", 0), -1, { ...onNew("beta", 0, 5), line: { side: "old", line: 6 } }),
    ).toBe("alpha:1:0");
  });

  test("treats a context line between blocks as standing between them", () => {
    expect(moveBlock(at("alpha", 0), 1, onNew("alpha", 0, 6))).toBe("alpha:0:1");
    expect(moveBlock(at("alpha", 0), -1, onNew("alpha", 0, 6))).toBe("alpha:0:0");
  });

  test("starts from the top of the selected hunk without a focus line", () => {
    expect(moveBlock(at("alpha", 1), 1)).toBe("alpha:1:0");
    expect(moveBlock(at("alpha", 1), -1)).toBe("alpha:0:1");
  });

  test("clamps on the last block and refuses to move past the first", () => {
    const onDeletion = { fileKey: "beta", hunkIndex: 0, line: { side: "old" as const, line: 5 } };

    // Standing on the last block re-lands on it, so the viewport returns to it like `]` does.
    expect(moveBlock(at("beta", 0), 1, onDeletion)).toBe("beta:0:0");
    expect(moveBlock(at("alpha", 0), -1, onNew("alpha", 0, 1))).toBeNull();
  });

  test("reveals the block's hunk and reports the block it landed on", () => {
    const target = planReviewSelectionMove(
      { ...model(), changeBlocks: CHANGE_BLOCKS, focus: onNew("alpha", 0, 3) },
      at("alpha", 0),
      { scope: "change-block", delta: 1 },
    );

    expect(target).toEqual({
      fileKey: "alpha",
      hunkIndex: 0,
      reveal: { anchor: "hunk", scrollToNote: false },
      landing: {
        kind: "change-block",
        block: {
          blockIndex: 1,
          oldStart: 10,
          deletions: 0,
          newStart: 10,
          additions: 1,
          line: { side: "new", line: 10 },
        },
      },
    });
  });

  test("flattens visible hunks' blocks in stream order", () => {
    const hunk = {
      additionStart: 1,
      additionCount: 3,
      deletionStart: 1,
      deletionCount: 2,
      hunkContent: [
        { type: "change" as const, additions: 1, deletions: 0 },
        { type: "context" as const, lines: 2 },
      ],
    };

    expect(
      reviewChangeBlockCursors([
        { fileKey: "alpha", hunks: [hunk, hunk], hunkIndexes: [1] },
        { fileKey: "beta", hunks: [hunk] },
      ]).map((block) => `${block.fileKey}:${block.hunkIndex}`),
    ).toEqual(["alpha:1", "beta:0"]);
  });
});

/** Stored and sidecar threads sharing alpha's first hunk, then one stored thread in beta. */
const THREADS: ReviewThreadCursor[] = [
  {
    fileKey: "alpha",
    hunkIndex: 0,
    line: { side: "new", line: 3 },
    threadId: "s1",
    kind: "stored",
  },
  {
    fileKey: "alpha",
    hunkIndex: 0,
    line: { side: "new", line: 3 },
    threadId: "sidecar:alpha:at:0",
    kind: "sidecar",
  },
  {
    fileKey: "alpha",
    hunkIndex: 0,
    line: { side: "new", line: 10 },
    threadId: "sidecar:alpha:at:1",
    kind: "sidecar",
  },
  { fileKey: "beta", hunkIndex: 1, line: { side: "new", line: 4 }, threadId: "s2", kind: "stored" },
];

/** Move through threads and report the thread landed on. */
function moveThread(
  selection: ReviewSemanticSelection,
  delta: number,
  extra: Partial<ReviewNavigationModel> = {},
) {
  const target = planReviewSelectionMove({ ...model(), threads: THREADS, ...extra }, selection, {
    scope: "comment-thread",
    delta,
  });
  return target?.landing?.kind === "comment-thread" ? target.landing.threadId : null;
}

describe("comment-thread movement", () => {
  test("visits every thread in one hunk, then crosses into the next file", () => {
    expect(moveThread(at("alpha", 0), 1, { activeThreadId: "s1" })).toBe("sidecar:alpha:at:0");
    expect(moveThread(at("alpha", 0), 1, { activeThreadId: "sidecar:alpha:at:0" })).toBe(
      "sidecar:alpha:at:1",
    );
    expect(moveThread(at("alpha", 0), 1, { activeThreadId: "sidecar:alpha:at:1" })).toBe("s2");
    expect(moveThread(at("beta", 1), -3, { activeThreadId: "s2" })).toBe("s1");
  });

  test("refuses to move past either end from an active thread", () => {
    expect(moveThread(at("beta", 1), 1, { activeThreadId: "s2" })).toBeNull();
    expect(moveThread(at("alpha", 0), -1, { activeThreadId: "s1" })).toBeNull();
  });

  test("treats a start on the anchor row as above the card hanging from it", () => {
    const focus = { fileKey: "alpha", hunkIndex: 0, line: { side: "new" as const, line: 3 } };

    expect(moveThread(at("alpha", 0), 1, { focus })).toBe("s1");
    expect(moveThread(at("alpha", 0), -1, { focus })).toBeNull();
    expect(
      moveThread(at("alpha", 0), -1, { focus: { ...focus, line: { side: "new", line: 5 } } }),
    ).toBe("sidecar:alpha:at:0");
  });

  test("enters from the selected hunk without a focus line", () => {
    expect(moveThread(at("beta", 0), 1)).toBe("s2");
    expect(moveThread(at("beta", 0), -1)).toBe("sidecar:alpha:at:1");
  });

  test("selects stored threads and only reveals sidecar threads", () => {
    const stored = planReviewSelectionMove({ ...model(), threads: THREADS }, at("beta", 0), {
      scope: "comment-thread",
      delta: 1,
    });
    const sidecar = planReviewSelectionMove(
      { ...model(), threads: THREADS, activeThreadId: "s1" },
      at("alpha", 0),
      { scope: "comment-thread", delta: 1 },
    );

    expect(stored).toMatchObject({
      fileKey: "beta",
      hunkIndex: 1,
      activeNoteId: "s2",
      reveal: { anchor: "hunk", scrollToNote: true },
    });
    expect(sidecar?.activeNoteId).toBeUndefined();
    expect(sidecar?.landing).toEqual({
      kind: "comment-thread",
      threadId: "sidecar:alpha:at:0",
      threadKind: "sidecar",
      line: { side: "new", line: 3 },
    });
  });
});
