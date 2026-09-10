import { describe, expect, test } from "bun:test";
import { getBundledUIRegistry } from ".";
import { paneKey } from "../../apply";
import { toExtensionPaintTheme } from "../../../ui/lib/extensionPaintTheme";
import { resolveInteractiveLogPalette } from "../../../ui/log/colorPolicy";
import { resolveTheme } from "../../../ui/themes";

describe("bundled UI registry", () => {
  test("projects the same commit metadata colors used by interactive history", () => {
    const appTheme = resolveTheme("github-dark-default", null);
    const paneTheme = toExtensionPaintTheme(appTheme);
    const logPalette = resolveInteractiveLogPalette(appTheme);

    expect({
      author: paneTheme.historyAuthor,
      separator: paneTheme.historySeparator,
      relativeTime: paneTheme.historyRelativeTime,
    }).toEqual({
      author: logPalette.author,
      separator: logPalette.separator,
      relativeTime: logPalette.relativeTime,
    });
  });

  test("registers the built-in files and delegated review info panes", () => {
    const panes = getBundledUIRegistry().panes;
    expect(panes.map(paneKey)).toEqual([
      "hunk:files",
      "hunk:review-info",
      "hunk:comparison-review-info",
    ]);
    const reviewInfo = panes[1]!.pane;
    const comparisonReviewInfo = panes[2]!.pane;
    expect(reviewInfo).toMatchObject({
      placement: "top",
      defaultOpen: true,
      height: { preferred: 3, min: 3, max: 3 },
    });
    expect(comparisonReviewInfo).toMatchObject({
      placement: "top",
      defaultOpen: true,
      resizable: false,
      height: { preferred: 3, min: 3, max: 10 },
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
        review: {
          kind: "commit",
          provider: "GitHub",
          title: "Commit title",
          revision: "abc1234",
          displayRevision: "abc1234",
        },
        placement: "top",
        files: [],
        selectedFileId: null,
        selectedHunkIndex: null,
        currentLine: null,
      }),
    ).toBeTrue();
    const comparisonContext = {
      review: {
        kind: "comparison" as const,
        provider: "Git",
        title: "2 commits",
        base: "base",
        head: "head",
        commitCount: 3,
        commits: [
          {
            title: "Commit",
            revision: "abcdef",
            displayRevision: "abcdef",
          },
          {
            title: "Older commit",
            revision: "123456",
            displayRevision: "123456",
          },
        ],
      },
      placement: "top" as const,
      files: [],
      selectedFileId: null,
      selectedHunkIndex: null,
      currentLine: null,
    };
    expect(comparisonReviewInfo.available?.(comparisonContext)).toBeTrue();
    expect(comparisonReviewInfo.preferredSize?.(comparisonContext)).toBe(4);
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
