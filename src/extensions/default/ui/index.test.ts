import { describe, expect, test } from "bun:test";
import { getBundledUIRegistry } from ".";
import { paneKey } from "../../apply";

describe("bundled UI registry", () => {
  test("registers the built-in files and delegated review info panes", () => {
    const panes = getBundledUIRegistry().panes;
    expect(panes.map(paneKey)).toEqual(["hunk:files", "hunk:review-info"]);
    const reviewInfo = panes[1]!.pane;
    expect(reviewInfo).toMatchObject({
      placement: "top",
      defaultOpen: true,
      height: { preferred: 3, min: 3, max: 3 },
    });
    expect(
      reviewInfo.available?.({
        review: {
          kind: "change-request",
          provider: "GitHub",
          title: "Title",
          id: "#1",
        },
        placement: "top",
        files: [],
        selectedFileId: null,
        selectedHunkIndex: null,
        currentLine: null,
      }),
    ).toBeTrue();
    expect(
      reviewInfo.available?.({
        review: null,
        placement: "top",
        files: [],
        selectedFileId: null,
        selectedHunkIndex: null,
        currentLine: null,
      }),
    ).toBeFalse();
  });
});
