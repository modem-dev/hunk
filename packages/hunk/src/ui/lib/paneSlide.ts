import type { ExtensionPaneLayoutPlan, PaneBounds, PlannedPane } from "./extensionPanes";

/** Duration of pane reveal and dismissal motion. */
export const PANE_SLIDE_DURATION_MS = 180;

/** Keep test-renderer transitions deterministic without changing interactive timing. */
export function paneSlideAnimationDuration(): number {
  return process.env.NODE_ENV === "test" ? 0 : PANE_SLIDE_DURATION_MS;
}

/** Interpolate terminal edges and derive dimensions so rounded bounds stay internally exact. */
function interpolateBounds(from: PaneBounds, to: PaneBounds, progress: number): PaneBounds {
  const value = (start: number, end: number) => Math.round(start + (end - start) * progress);
  const x = value(from.x, to.x);
  const y = value(from.y, to.y);
  const right = value(from.x + from.width, to.x + to.width);
  const bottom = value(from.y + from.height, to.y + to.height);
  return { x, y, width: right - x, height: bottom - y };
}

/** Move a full-size pane beyond the outer body edge it enters from. */
function offscreenPane(planned: PlannedPane, layout: ExtensionPaneLayoutPlan): PlannedPane {
  const bodyRight = Math.max(
    layout.reviewBounds.x + layout.reviewBounds.width,
    ...layout.panes.map(({ bounds }) => bounds.x + bounds.width),
  );
  const bodyBottom = Math.max(
    layout.reviewBounds.y + layout.reviewBounds.height,
    ...layout.panes.map(({ bounds }) => bounds.y + bounds.height),
  );
  const { placement } = planned.pane;
  const target =
    placement === "left"
      ? { x: -planned.bounds.width, y: planned.bounds.y }
      : placement === "right"
        ? { x: bodyRight, y: planned.bounds.y }
        : placement === "top"
          ? { x: planned.bounds.x, y: -planned.bounds.height }
          : { x: planned.bounds.x, y: bodyBottom };
  const offset = { x: target.x - planned.bounds.x, y: target.y - planned.bounds.y };
  const translate = (bounds: PaneBounds): PaneBounds => ({
    ...bounds,
    x: bounds.x + offset.x,
    y: bounds.y + offset.y,
  });

  return {
    ...planned,
    bounds: translate(planned.bounds),
    ...(planned.divider ? { divider: translate(planned.divider) } : {}),
  };
}

/** Return the sole pane whose visibility changed, or null for a broader layout change. */
export function paneVisibilityTransitionKey(
  from: ExtensionPaneLayoutPlan,
  to: ExtensionPaneLayoutPlan,
): string | null {
  const fromKeys = from.panes.map(({ pane }) => pane.key);
  const toKeys = to.panes.map(({ pane }) => pane.key);
  const fromSet = new Set(fromKeys);
  const toSet = new Set(toKeys);
  const changedKeys = [
    ...fromKeys.filter((key) => !toSet.has(key)),
    ...toKeys.filter((key) => !fromSet.has(key)),
  ];
  if (changedKeys.length !== 1) return null;

  const changedKey = changedKeys[0]!;
  const withoutChanged = (keys: readonly string[]) => keys.filter((key) => key !== changedKey);
  const fromOtherKeys = withoutChanged(fromKeys);
  const toOtherKeys = withoutChanged(toKeys);
  return fromOtherKeys.length === toOtherKeys.length &&
    fromOtherKeys.every((key, index) => key === toOtherKeys[index])
    ? changedKey
    : null;
}

/** Return whether two presentation plans occupy the same terminal cells. */
export function paneLayoutGeometryEqual(
  left: ExtensionPaneLayoutPlan,
  right: ExtensionPaneLayoutPlan,
): boolean {
  const boundsEqual = (a: PaneBounds, b: PaneBounds) =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  if (
    !boundsEqual(left.reviewBounds, right.reviewBounds) ||
    left.panes.length !== right.panes.length
  ) {
    return false;
  }
  return left.panes.every((planned, index) => {
    const other = right.panes[index];
    return (
      other !== undefined &&
      planned.pane.key === other.pane.key &&
      boundsEqual(planned.bounds, other.bounds) &&
      (planned.divider === undefined
        ? other.divider === undefined
        : other.divider !== undefined && boundsEqual(planned.divider, other.divider))
    );
  });
}

/** Project one pane animation frame without changing the authoritative semantic plan. */
export function interpolatePaneLayout(
  from: ExtensionPaneLayoutPlan,
  to: ExtensionPaneLayoutPlan,
  transitioningPaneKey: string,
  progress: number,
): ExtensionPaneLayoutPlan {
  const boundedProgress = Math.min(1, Math.max(0, progress));
  const fromByKey = new Map(from.panes.map((planned) => [planned.pane.key, planned]));
  const toByKey = new Map(to.panes.map((planned) => [planned.pane.key, planned]));
  const layoutWithTransitioningPane = fromByKey.has(transitioningPaneKey) ? from : to;
  const keys = layoutWithTransitioningPane.panes.map(({ pane }) => pane.key);

  const panes = keys.flatMap((key) => {
    const fromPane = fromByKey.get(key);
    const toPane = toByKey.get(key);
    if (!fromPane && !toPane) return [];

    const start =
      fromPane ?? (toPane && key === transitioningPaneKey ? offscreenPane(toPane, to) : toPane);
    const end =
      toPane ??
      (fromPane && key === transitioningPaneKey ? offscreenPane(fromPane, from) : fromPane);
    if (!start || !end) return [];

    const divider =
      start.divider && end.divider
        ? interpolateBounds(start.divider, end.divider, boundedProgress)
        : end.divider;
    return [
      {
        pane: end.pane,
        bounds: interpolateBounds(start.bounds, end.bounds, boundedProgress),
        ...(divider ? { divider } : {}),
      },
    ];
  });

  return {
    panes,
    reviewBounds: interpolateBounds(from.reviewBounds, to.reviewBounds, boundedProgress),
    omittedKeys: to.omittedKeys,
  };
}
