import { describe, expect, test } from "bun:test";
import { HUNK_FILES_PANE_KEY } from "../../extensions/extensionIds";
import {
  buildSessionPanes,
  planExtensionPanes,
  type ExtensionPaneLayoutPlan,
} from "./extensionPanes";
import { interpolateSidebarLayout, isSidebarVisibilityTransition } from "./sidebarSlide";

/** Build matching open and closed semantic layouts for the bundled files pane. */
function createSidebarLayouts(): {
  closed: ExtensionPaneLayoutPlan;
  open: ExtensionPaneLayoutPlan;
} {
  const panes = buildSessionPanes(undefined);
  const plan = (openKeys: readonly string[]) =>
    planExtensionPanes({
      panes,
      openKeys,
      sizes: { [HUNK_FILES_PANE_KEY]: 30 },
      bodyWidth: 100,
      bodyHeight: 20,
      minReviewWidth: 20,
      minReviewHeight: 5,
    });
  return {
    closed: plan([]),
    open: plan([HUNK_FILES_PANE_KEY]),
  };
}

describe("sidebar slide presentation", () => {
  test("recognizes only a files-pane visibility change", () => {
    const { closed, open } = createSidebarLayouts();

    expect(isSidebarVisibilityTransition(closed, open, HUNK_FILES_PANE_KEY)).toBe(true);
    expect(isSidebarVisibilityTransition(open, closed, HUNK_FILES_PANE_KEY)).toBe(true);
    expect(isSidebarVisibilityTransition(open, open, HUNK_FILES_PANE_KEY)).toBe(false);
  });

  test("slides the sidebar and review geometry together when opening", () => {
    const { closed, open } = createSidebarLayouts();
    const start = interpolateSidebarLayout(closed, open, HUNK_FILES_PANE_KEY, 0);
    const middle = interpolateSidebarLayout(closed, open, HUNK_FILES_PANE_KEY, 0.5);
    const openPane = open.panes.find(({ pane }) => pane.key === HUNK_FILES_PANE_KEY)!;
    const middlePane = middle.panes.find(({ pane }) => pane.key === HUNK_FILES_PANE_KEY)!;

    expect(start.reviewBounds).toEqual(closed.reviewBounds);
    expect(start.panes.find(({ pane }) => pane.key === HUNK_FILES_PANE_KEY)?.bounds.width).toBe(0);
    expect(middlePane.bounds.width).toBeGreaterThan(0);
    expect(middlePane.bounds.width).toBeLessThan(openPane.bounds.width);
    expect(middle.reviewBounds.x).toBeGreaterThan(closed.reviewBounds.x);
    expect(middle.reviewBounds.x).toBeLessThan(open.reviewBounds.x);
  });

  test("retains the exiting files pane until the closing frame completes", () => {
    const { closed, open } = createSidebarLayouts();
    const middle = interpolateSidebarLayout(open, closed, HUNK_FILES_PANE_KEY, 0.5);
    const end = interpolateSidebarLayout(open, closed, HUNK_FILES_PANE_KEY, 1);

    expect(middle.panes.some(({ pane }) => pane.key === HUNK_FILES_PANE_KEY)).toBe(true);
    expect(end.panes.some(({ pane }) => pane.key === HUNK_FILES_PANE_KEY)).toBe(true);
    expect(end.panes.find(({ pane }) => pane.key === HUNK_FILES_PANE_KEY)?.bounds.width).toBe(0);
    expect(end.reviewBounds).toEqual(closed.reviewBounds);
  });
});
