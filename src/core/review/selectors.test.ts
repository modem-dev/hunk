import { describe, expect, test } from "bun:test";
import { createTestReviewState } from "../../../test/helpers/review-store-helpers";
import { reduceReviewState } from "./reducer";
import {
  isReviewGapExpanded,
  reviewFileKeysWithRetiredContent,
  selectExpandedGapIdsByFileKey,
  selectReviewFileByKey,
} from "./selectors";

describe("file selectors", () => {
  test("resolve a file by key and reject an unknown one", () => {
    const state = createTestReviewState();

    expect(selectReviewFileByKey(state, "beta")?.key).toBe("beta");
    expect(selectReviewFileByKey(state, "missing")).toBeUndefined();
    expect(selectReviewFileByKey(state, null)).toBeUndefined();
  });
});

describe("reviewFileKeysWithRetiredContent", () => {
  test("names files that left the review or came back with different content", () => {
    const previous = createTestReviewState([
      { key: "alpha", sourceIdentity: "source-1" },
      { key: "beta", sourceIdentity: "source-1" },
      { key: "gamma" },
    ]).document;
    const next = createTestReviewState([
      { key: "alpha", sourceIdentity: "source-1" },
      { key: "beta", sourceIdentity: "source-2" },
      { key: "delta" },
    ]).document;

    expect([...reviewFileKeysWithRetiredContent(previous, next)]).toEqual(["beta", "gamma"]);
  });

  test("retires nothing when the same content is reloaded", () => {
    const document = createTestReviewState([{ key: "alpha", sourceIdentity: "source-1" }]).document;

    expect([...reviewFileKeysWithRetiredContent(document, document)]).toEqual([]);
  });
});

describe("expansion selectors", () => {
  test("report expansion per gap and per file", () => {
    const expanded = [
      { fileKey: "alpha", gapId: "before:1", expanded: true },
      { fileKey: "alpha", gapId: "before:2", expanded: false },
      { fileKey: "beta", gapId: "trailing:0", expanded: true },
    ].reduce(
      (state, gap) => reduceReviewState(state, { type: "expansion/toggle", ...gap }),
      createTestReviewState(),
    );

    expect(isReviewGapExpanded(expanded, "alpha", "before:1")).toBe(true);
    expect(isReviewGapExpanded(expanded, "alpha", "before:2")).toBe(false);
    expect(isReviewGapExpanded(expanded, "gamma", "before:1")).toBe(false);
    expect(selectExpandedGapIdsByFileKey(expanded)).toEqual({
      alpha: new Set(["before:1"]),
      beta: new Set(["trailing:0"]),
    });
  });
});
