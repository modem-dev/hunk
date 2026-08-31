import { describe, expect, test } from "bun:test";
import type { ExtensionPane } from "../../extension-api/types";
import { HUNK_FILES_PANE_KEY } from "../../extensions/extensionIds";
import {
  buildSessionPanes,
  planExtensionPanes,
  type ExtensionPaneLayoutPlan,
  type SessionPane,
} from "./extensionPanes";
import { interpolatePaneLayout, paneVisibilityTransitionKey } from "./paneSlide";

/** Build matching open and closed layouts for a pane at one edge. */
function createPaneLayouts(placement: SessionPane["placement"]): {
  closed: ExtensionPaneLayoutPlan;
  open: ExtensionPaneLayoutPlan;
  paneKey: string;
} {
  const bundled = buildSessionPanes(undefined)[0]!;
  const paneKey = placement === "left" ? HUNK_FILES_PANE_KEY : `test:${placement}`;
  const pane: SessionPane = {
    ...bundled,
    key: paneKey,
    placement,
    registered: {
      ...bundled.registered,
      pane: { ...bundled.registered.pane, id: placement, placement } as ExtensionPane,
    },
  };
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

      expect(start.reviewBounds).toEqual(closed.reviewBounds);
      expect(start.panes.find(({ pane }) => pane.key === paneKey)?.bounds.width).toBe(0);
      expect(middlePane.bounds.width).toBeGreaterThan(0);
      expect(middlePane.bounds.width).toBeLessThan(openPane.bounds.width);
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

      expect(start.reviewBounds).toEqual(closed.reviewBounds);
      expect(start.panes.find(({ pane }) => pane.key === paneKey)?.bounds.height).toBe(0);
      expect(middlePane.bounds.height).toBeGreaterThan(0);
      expect(middlePane.bounds.height).toBeLessThan(openPane.bounds.height);
      expect(middle.reviewBounds.height).toBeGreaterThan(open.reviewBounds.height);
      expect(middle.reviewBounds.height).toBeLessThan(closed.reviewBounds.height);
    }
  });

  test("retains an exiting pane until the closing frame completes", () => {
    const { closed, open, paneKey } = createPaneLayouts("bottom");
    const middle = interpolatePaneLayout(open, closed, paneKey, 0.5);
    const end = interpolatePaneLayout(open, closed, paneKey, 1);

    expect(middle.panes.some(({ pane }) => pane.key === paneKey)).toBe(true);
    expect(end.panes.some(({ pane }) => pane.key === paneKey)).toBe(true);
    expect(end.panes.find(({ pane }) => pane.key === paneKey)?.bounds.height).toBe(0);
    expect(end.reviewBounds).toEqual(closed.reviewBounds);
  });
});
