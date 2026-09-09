import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { toReadOnlyFileViews } from "../../extensions/events";
import { buildExtensionReviewSelection } from "./extensionSelection";

/** The frozen views the sidebar panes render from, for two visible files. */
function createTestFileViews() {
  return toReadOnlyFileViews([
    createTestDiffFile({ id: "alpha", path: "alpha.ts" }),
    createTestDiffFile({ id: "beta", path: "beta.ts" }),
  ]);
}

describe("buildExtensionReviewSelection", () => {
  test("resolves the selected file and hunk out of the visible views", () => {
    const files = createTestFileViews();
    const selection = buildExtensionReviewSelection({
      files,
      selectedFileId: "beta",
      selectedHunkIndex: 0,
    });

    expect(selection.file?.path).toBe("beta.ts");
    expect(selection.hunkIndex).toBe(0);
    expect(selection.currentLine).toBeNull();
  });

  test("reports no selection when nothing is selected", () => {
    const selection = buildExtensionReviewSelection({
      files: createTestFileViews(),
      selectedFileId: null,
      selectedHunkIndex: 3,
    });

    expect(selection).toEqual({ file: null, hunkIndex: null, currentLine: null });
  });

  test("reports no selection for a file the filter hides", () => {
    // The review controller keeps a selection that the current filter query
    // hides; an extension cannot find that file in `files`, so it is not one it
    // can act on either.
    const selection = buildExtensionReviewSelection({
      files: createTestFileViews(),
      selectedFileId: "gamma",
      selectedHunkIndex: 0,
    });

    expect(selection).toEqual({ file: null, hunkIndex: null, currentLine: null });
  });

  test("copies the matching current line into the frozen snapshot", () => {
    const files = createTestFileViews();
    const target = { side: "old" as const, line: 42 };
    const selection = buildExtensionReviewSelection({
      files,
      selectedFileId: "alpha",
      selectedHunkIndex: 0,
      lineCursor: { fileId: "alpha", hunkIndex: 0, target },
    });

    expect(selection.currentLine).toEqual(target);
    expect(selection.currentLine).not.toBe(target);
    expect(Object.isFrozen(selection.currentLine)).toBe(true);
    expect(Object.isFrozen(selection)).toBe(true);
  });

  test("drops a current line outside the resolved file and hunk", () => {
    const files = createTestFileViews();
    const target = { side: "old" as const, line: 7 };

    expect(
      buildExtensionReviewSelection({
        files,
        selectedFileId: "alpha",
        selectedHunkIndex: 0,
        lineCursor: { fileId: "beta", hunkIndex: 0, target },
      }).currentLine,
    ).toBeNull();
    expect(
      buildExtensionReviewSelection({
        files,
        selectedFileId: "alpha",
        selectedHunkIndex: 0,
        lineCursor: { fileId: "alpha", hunkIndex: 1, target },
      }).currentLine,
    ).toBeNull();
  });

  test("clamps a stale hunk index into the file's real range", () => {
    const files = createTestFileViews();
    const lastHunkIndex = (files[0]!.metadata as { hunks: unknown[] }).hunks.length - 1;

    expect(
      buildExtensionReviewSelection({ files, selectedFileId: "alpha", selectedHunkIndex: 99 })
        .hunkIndex,
    ).toBe(lastHunkIndex);
    expect(
      buildExtensionReviewSelection({ files, selectedFileId: "alpha", selectedHunkIndex: -4 })
        .hunkIndex,
    ).toBe(0);
    expect(
      buildExtensionReviewSelection({
        files,
        selectedFileId: "alpha",
        selectedHunkIndex: Number.NaN,
      }).hunkIndex,
    ).toBeNull();
  });

  test("reports no hunk for a file with nothing to select", () => {
    const [file] = createTestFileViews();
    const binaryLike = Object.freeze({ ...file!, id: "binary", metadata: { hunks: [] } });

    expect(
      buildExtensionReviewSelection({
        files: [binaryLike],
        selectedFileId: "binary",
        selectedHunkIndex: 0,
      }).hunkIndex,
    ).toBeNull();
  });

  test("hands out the frozen view the sidebar receives, in a frozen snapshot", () => {
    const files = createTestFileViews();
    const selection = buildExtensionReviewSelection({
      files,
      selectedFileId: "alpha",
      selectedHunkIndex: 0,
    });

    // Same object identity as the sidebar's props, and frozen: an extension
    // holding the snapshot cannot reach the review model through it.
    expect(selection.file).toBe(files[0]!);
    expect(Object.isFrozen(selection.file)).toBe(true);
    expect(Object.isFrozen(selection)).toBe(true);
  });
});
