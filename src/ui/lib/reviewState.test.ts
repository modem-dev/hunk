import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import { buildReviewState } from "./reviewState";

/** Build a minimal review-state input with sensible defaults that callers can override. */
function buildOptions(overrides: Partial<Parameters<typeof buildReviewState>[0]> = {}) {
  return {
    files: [],
    liveCommentsByFileId: {},
    filterQuery: "",
    markedFileIds: new Set<string>(),
    selectedFileId: "",
    selectedHunkIndex: 0,
    ...overrides,
  };
}

describe("buildReviewState marked files", () => {
  test("hides marked files from the review stream while keeping them in the sidebar", () => {
    const alpha = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: lines("export const alpha = 1;"),
      after: lines("export const alpha = 2;"),
    });
    const beta = createTestDiffFile({
      id: "beta",
      path: "beta.ts",
      before: lines("export const beta = 1;"),
      after: lines("export const beta = 2;"),
    });

    const state = buildReviewState(
      buildOptions({
        files: [alpha, beta],
        markedFileIds: new Set([alpha.id]),
        selectedFileId: beta.id,
      }),
    );

    expect(state.visibleFiles.map((file) => file.id)).toEqual(["beta"]);
    expect(state.unmarkedFiles.map((file) => file.id)).toEqual(["beta"]);
    expect(state.hiddenByMarkCount).toBe(1);

    const fileEntries = state.sidebarEntries.filter((entry) => entry.kind === "file");
    expect(fileEntries.map((entry) => entry.id)).toEqual(["alpha", "beta"]);
    expect(fileEntries.map((entry) => entry.marked)).toEqual([true, false]);
    expect(state.hunkCursors.every((cursor) => cursor.fileId === "beta")).toBe(true);
  });

  test("a marked file is not visible even when the filter would otherwise match it", () => {
    const alpha = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: lines("export const alpha = 1;"),
      after: lines("export const alpha = 2;"),
    });
    const beta = createTestDiffFile({
      id: "beta",
      path: "beta.ts",
      before: lines("export const beta = 1;"),
      after: lines("export const beta = 2;"),
    });

    const state = buildReviewState(
      buildOptions({
        files: [alpha, beta],
        filterQuery: "alpha",
        markedFileIds: new Set([alpha.id]),
      }),
    );

    expect(state.visibleFiles.map((file) => file.id)).toEqual([]);
    expect(state.unmarkedFiles.map((file) => file.id)).toEqual(["beta"]);
    expect(state.hiddenByMarkCount).toBe(1);
    // The sidebar still respects the filter so the user sees a narrow consistent view, but
    // the matched alpha entry is flagged as marked so it stays unmarkable.
    const fileEntries = state.sidebarEntries.filter((entry) => entry.kind === "file");
    expect(fileEntries.map((entry) => entry.id)).toEqual(["alpha"]);
    expect(fileEntries[0]?.marked).toBe(true);
  });

  test("an empty mark set leaves the review stream and sidebar untouched", () => {
    const alpha = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: lines("export const alpha = 1;"),
      after: lines("export const alpha = 2;"),
    });

    const state = buildReviewState(buildOptions({ files: [alpha], selectedFileId: alpha.id }));

    expect(state.visibleFiles.map((file) => file.id)).toEqual(["alpha"]);
    expect(state.hiddenByMarkCount).toBe(0);
    expect(
      state.sidebarEntries
        .filter((entry) => entry.kind === "file")
        .every((entry) => entry.marked === false),
    ).toBe(true);
  });
});
