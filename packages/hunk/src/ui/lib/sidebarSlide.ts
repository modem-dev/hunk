import type { ExtensionPaneLayoutPlan, PaneBounds, PlannedPane } from "./extensionPanes";

/** Duration of the files-sidebar reveal and dismissal motion. */
export const SIDEBAR_SLIDE_DURATION_MS = 180;

/** Keep test-renderer transitions deterministic without changing interactive timing. */
export function sidebarSlideAnimationDuration(): number {
  return process.env.NODE_ENV === "test" ? 0 : SIDEBAR_SLIDE_DURATION_MS;
}

/** Interpolate terminal geometry while snapping each value to a whole cell. */
function interpolateBounds(from: PaneBounds, to: PaneBounds, progress: number): PaneBounds {
  const value = (start: number, end: number) => Math.round(start + (end - start) * progress);
  return {
    x: value(from.x, to.x),
    y: value(from.y, to.y),
    width: value(from.width, to.width),
    height: value(from.height, to.height),
  };
}

/** Collapse a side pane just beyond the edge it enters from. */
function collapsedPane(planned: PlannedPane): PlannedPane {
  const rightEdge = planned.bounds.x + planned.bounds.width;
  const x = planned.pane.placement === "right" ? rightEdge : planned.bounds.x;
  return {
    ...planned,
    bounds: { ...planned.bounds, x, width: 0 },
    ...(planned.divider
      ? {
          divider: {
            ...planned.divider,
            x,
            width: 0,
          },
        }
      : {}),
  };
}

/** Return whether two semantic layouts differ only by files-pane visibility. */
export function isSidebarVisibilityTransition(
  from: ExtensionPaneLayoutPlan,
  to: ExtensionPaneLayoutPlan,
  filesPaneKey: string,
): boolean {
  const fromKeys = from.panes.map(({ pane }) => pane.key);
  const toKeys = to.panes.map(({ pane }) => pane.key);
  const fromFiles = from.panes.find(({ pane }) => pane.key === filesPaneKey);
  const toFiles = to.panes.find(({ pane }) => pane.key === filesPaneKey);
  if (Boolean(fromFiles) === Boolean(toFiles)) return false;
  const filesPane = fromFiles ?? toFiles;
  if (filesPane?.pane.placement !== "left" && filesPane?.pane.placement !== "right") return false;

  const withoutFiles = (keys: readonly string[]) => keys.filter((key) => key !== filesPaneKey);
  const fromOtherKeys = withoutFiles(fromKeys);
  const toOtherKeys = withoutFiles(toKeys);
  return (
    fromOtherKeys.length === toOtherKeys.length &&
    fromOtherKeys.every((key, index) => key === toOtherKeys[index])
  );
}

/** Project one animation frame without changing the authoritative semantic pane plan. */
export function interpolateSidebarLayout(
  from: ExtensionPaneLayoutPlan,
  to: ExtensionPaneLayoutPlan,
  filesPaneKey: string,
  progress: number,
): ExtensionPaneLayoutPlan {
  const boundedProgress = Math.min(1, Math.max(0, progress));
  const fromByKey = new Map(from.panes.map((planned) => [planned.pane.key, planned]));
  const toByKey = new Map(to.panes.map((planned) => [planned.pane.key, planned]));
  const layoutWithFiles = fromByKey.has(filesPaneKey) ? from : to;
  const keys = layoutWithFiles.panes.map(({ pane }) => pane.key);

  const panes = keys.flatMap((key) => {
    const fromPane = fromByKey.get(key);
    const toPane = toByKey.get(key);
    if (!fromPane && !toPane) return [];

    const start = fromPane ?? (toPane && key === filesPaneKey ? collapsedPane(toPane) : toPane);
    const end = toPane ?? (fromPane && key === filesPaneKey ? collapsedPane(fromPane) : fromPane);
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
