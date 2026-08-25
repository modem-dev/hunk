import { describe, expect, test } from "bun:test";
import {
  EMPTY_REVIEW_ANNOTATION_INDEX,
  planReviewSelectionMove,
  REVIEW_SELECTION_WRAP_POLICY,
  reviewAnnotatedCursors,
  reviewStreamCursors,
  type ReviewAnnotationIndex,
  type ReviewNavigationFile,
  type ReviewNavigationModel,
  type ReviewSelectionScope,
} from "./navigation";
import type { ReviewSemanticSelection } from "./state";

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
      "annotated-hunk": "clamp",
      "annotated-file": "wrap",
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

  test("steps files onto their first hunk and refuses a move that would go nowhere", () => {
    expect(move(model(), at("alpha", 1), "file", 1)).toEqual({
      at: "beta:0",
      reveal: { anchor: "file-top", scrollToNote: false },
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
