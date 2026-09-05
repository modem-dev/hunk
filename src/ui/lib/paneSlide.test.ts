import { describe, expect, test } from "bun:test";
import type { ExtensionPane } from "../../extension-api/types";
import { HUNK_FILES_PANE_KEY } from "../../extensions/extensionIds";
import {
  buildSessionPanes,
  planExtensionPanes,
  type ExtensionPaneLayoutPlan,
  type SessionPane,
} from "./extensionPanes";
import {
  interpolatePaneLayout,
  paneLayoutGeometryEqual,
  paneVisibilityTransitionKey,
} from "./paneSlide";

/** Build one test pane from the bundled pane's valid registration shell. */
function createTestPane(
  placement: SessionPane["placement"],
  suffix: string = placement,
): SessionPane {
  const bundled = buildSessionPanes(undefined)[0]!;
  const paneKey =
    placement === "left" && suffix === placement ? HUNK_FILES_PANE_KEY : `test:${suffix}`;
  return {
    ...bundled,
    key: paneKey,
    placement,
    registered: {
      ...bundled.registered,
      pane: { ...bundled.registered.pane, id: suffix, placement } as ExtensionPane,
    },
  };
}

/** Build matching open and closed layouts for a pane at one edge. */
function createPaneLayouts(placement: SessionPane["placement"]): {
  closed: ExtensionPaneLayoutPlan;
  open: ExtensionPaneLayoutPlan;
  paneKey: string;
} {
  const pane = createTestPane(placement);
  const paneKey = pane.key;
  const plan = (openKeys: readonly string[]) =>
    planExtensionPanes({
      panes: [pane],
      openKeys,
      sizes: { [paneKey]: placement === "left" || placement === "right" ? 30 : 8 },
      bodyWidth: 100,
      bodyHeight: 30,
      minReviewWidth: 20,
      minReviewHeight: 5,
    });
  return {
    closed: plan([]),
    open: plan([paneKey]),
    paneKey,
  };
}

describe("pane slide presentation", () => {
  test("recognizes any sole pane visibility change", () => {
    for (const placement of ["left", "right", "top", "bottom"] as const) {
      const { closed, open, paneKey } = createPaneLayouts(placement);
      expect(paneVisibilityTransitionKey(closed, open)).toBe(paneKey);
      expect(paneVisibilityTransitionKey(open, closed)).toBe(paneKey);
      expect(paneVisibilityTransitionKey(open, open)).toBeNull();
    }
  });

  test("slides horizontal panes and review geometry together", () => {
    for (const placement of ["left", "right"] as const) {
      const { closed, open, paneKey } = createPaneLayouts(placement);
      const start = interpolatePaneLayout(closed, open, paneKey, 0);
      const middle = interpolatePaneLayout(closed, open, paneKey, 0.5);
      const openPane = open.panes.find(({ pane }) => pane.key === paneKey)!;
      const middlePane = middle.panes.find(({ pane }) => pane.key === paneKey)!;

      const startPane = start.panes.find(({ pane }) => pane.key === paneKey)!;
      expect(start.reviewBounds).toEqual(closed.reviewBounds);
      expect(startPane.bounds.width).toBe(openPane.bounds.width);
      expect(startPane.bounds.x).not.toBe(openPane.bounds.x);
      expect(middlePane.bounds.width).toBe(openPane.bounds.width);
      expect(middlePane.bounds.x).not.toBe(openPane.bounds.x);
      expect(middle.reviewBounds.width).toBeGreaterThan(open.reviewBounds.width);
      expect(middle.reviewBounds.width).toBeLessThan(closed.reviewBounds.width);
    }
  });

  test("slides vertical panes and review geometry together", () => {
    for (const placement of ["top", "bottom"] as const) {
      const { closed, open, paneKey } = createPaneLayouts(placement);
      const start = interpolatePaneLayout(closed, open, paneKey, 0);
      const middle = interpolatePaneLayout(closed, open, paneKey, 0.5);
      const openPane = open.panes.find(({ pane }) => pane.key === paneKey)!;
      const middlePane = middle.panes.find(({ pane }) => pane.key === paneKey)!;

      const startPane = start.panes.find(({ pane }) => pane.key === paneKey)!;
      expect(start.reviewBounds).toEqual(closed.reviewBounds);
      expect(startPane.bounds.height).toBe(openPane.bounds.height);
      expect(startPane.bounds.y).not.toBe(openPane.bounds.y);
      expect(middlePane.bounds.height).toBe(openPane.bounds.height);
      expect(middlePane.bounds.y).not.toBe(openPane.bounds.y);
      expect(middle.reviewBounds.height).toBeGreaterThan(open.reviewBounds.height);
      expect(middle.reviewBounds.height).toBeLessThan(closed.reviewBounds.height);
    }
  });

  test("starts an additional same-edge pane beyond the occupied outer edge", () => {
    const first = createTestPane("left", "first");
    const second = createTestPane("left", "second");
    const plan = (openKeys: readonly string[]) =>
      planExtensionPanes({
        panes: [first, second],
        openKeys,
        sizes: { [first.key]: 20, [second.key]: 20 },
        bodyWidth: 100,
        bodyHeight: 30,
        minReviewWidth: 20,
        minReviewHeight: 5,
      });
    const before = plan([first.key]);
    const after = plan([first.key, second.key]);
    const start = interpolatePaneLayout(before, after, second.key, 0);
    const firstBounds = start.panes.find(({ pane }) => pane.key === first.key)!.bounds;
    const secondBounds = start.panes.find(({ pane }) => pane.key === second.key)!.bounds;

    expect(secondBounds.x + secondBounds.width).toBeLessThanOrEqual(firstBounds.x);
  });

  test("keeps interpolated review edges inside the body", () => {
    const { closed, open, paneKey } = createPaneLayouts("left");
    for (const progress of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const { reviewBounds } = interpolatePaneLayout(closed, open, paneKey, progress);
      expect(reviewBounds.x + reviewBounds.width).toBe(100);
    }
  });

  test("deduplicates timeline updates that round to the same terminal cells", () => {
    const { closed, open, paneKey } = createPaneLayouts("top");
    const first = interpolatePaneLayout(closed, open, paneKey, 0.1);
    const sameCells = interpolatePaneLayout(closed, open, paneKey, 0.101);
    const later = interpolatePaneLayout(closed, open, paneKey, 0.5);

    expect(paneLayoutGeometryEqual(first, sameCells)).toBe(true);
    expect(paneLayoutGeometryEqual(first, later)).toBe(false);
  });

  test("retains an exiting pane until the closing frame completes", () => {
    const { closed, open, paneKey } = createPaneLayouts("bottom");
    const middle = interpolatePaneLayout(open, closed, paneKey, 0.5);
    const end = interpolatePaneLayout(open, closed, paneKey, 1);

    expect(middle.panes.some(({ pane }) => pane.key === paneKey)).toBe(true);
    expect(end.panes.some(({ pane }) => pane.key === paneKey)).toBe(true);
    const openPane = open.panes.find(({ pane }) => pane.key === paneKey)!;
    const endPane = end.panes.find(({ pane }) => pane.key === paneKey)!;
    expect(endPane.bounds.height).toBe(openPane.bounds.height);
    expect(endPane.bounds.y).toBeGreaterThan(openPane.bounds.y);
    expect(end.reviewBounds).toEqual(closed.reviewBounds);
  });
});
