import { resolveExtensionSidebarViews, sidebarViewKey } from "../../extensions/apply";
import { getBundledSidebarView } from "../../extensions/default/ui/sidebar";
import type { ExtensionLoadResult, RegisteredSidebarView } from "../../extensions/types";

/**
 * The session's sidebar model: which views exist, which are open, and how the
 * open ones share the terminal with the review stream.
 *
 * Everything here is a pure derivation so rendering, resizing, and the
 * extension-facing sidebar controls all read one plan instead of re-deriving
 * pane arrangement ad hoc.
 */

/** Which side of the review stream one pane sits on. */
export type SidebarPlacement = "left" | "right";

/** One sidebar view available to this session, open or not. */
export interface SessionSidebarView {
  /** Stable key: `<extensionId>:<viewId>`; the bundled file navigation is `hunk:files`. */
  key: string;
  registered: RegisteredSidebarView;
  placement: SidebarPlacement;
  title: string;
  defaultOpen: boolean;
}

/** The key the bundled file-navigation view is addressed by. */
export function bundledSidebarViewKey() {
  return sidebarViewKey(getBundledSidebarView());
}

/**
 * Compose the session's sidebar views: the bundled file navigation first,
 * then every extension-registered view in registration order.
 *
 * A registered view with `replacesDefault` starts open in place of the
 * bundled view — which stays available, just closed, so a command or a
 * future menu can reopen it.
 */
export function buildSessionSidebarViews(
  extensions: ExtensionLoadResult | undefined,
): SessionSidebarView[] {
  const bundled = getBundledSidebarView();
  const registered = extensions ? resolveExtensionSidebarViews(extensions.registry).views : [];
  const replacesDefault = registered.some((entry) => entry.view.replacesDefault === true);

  return [
    {
      key: sidebarViewKey(bundled),
      registered: bundled,
      placement: "left",
      title: "Files",
      defaultOpen: !replacesDefault,
    },
    ...registered.map((entry) => ({
      key: sidebarViewKey(entry),
      registered: entry,
      placement: entry.view.placement ?? ("left" as const),
      title: entry.view.title ?? entry.view.id,
      defaultOpen: entry.view.defaultOpen === true || entry.view.replacesDefault === true,
    })),
  ];
}

/**
 * Which views are open, plus which keys have been seen before.
 *
 * `known` is what distinguishes "newly registered, apply its defaultOpen"
 * from "the user closed this earlier" when extensions reload mid-session.
 */
export interface SidebarOpenState {
  known: readonly string[];
  open: readonly string[];
}

/** Build the open state a fresh session starts with. */
export function initialSidebarOpenState(views: readonly SessionSidebarView[]): SidebarOpenState {
  return {
    known: views.map((view) => view.key),
    open: views.filter((view) => view.defaultOpen).map((view) => view.key),
  };
}

/**
 * Carry open/closed choices across an extension reload.
 *
 * Views that disappeared drop out; views seen before keep the user's choice;
 * brand-new views apply their own `defaultOpen`. Returns the previous state
 * object untouched when nothing changed, so effect loops stay quiet.
 */
export function reconcileSidebarOpenState(
  views: readonly SessionSidebarView[],
  state: SidebarOpenState,
): SidebarOpenState {
  const keys = views.map((view) => view.key);
  const known = new Set(state.known);
  const open = new Set(state.open);

  const nextOpen = views
    .filter((view) => (known.has(view.key) ? open.has(view.key) : view.defaultOpen))
    .map((view) => view.key);

  const sameKnown = keys.length === state.known.length && keys.every((key) => known.has(key));
  const sameOpen =
    nextOpen.length === state.open.length &&
    nextOpen.every((key, index) => state.open[index] === key);
  if (sameKnown && sameOpen) {
    return state;
  }

  return { known: keys, open: nextOpen };
}

/**
 * Resolve the view a sidebar-controls call names.
 *
 * A bare id resolves within the calling extension first; `"files"` is the
 * bundled file navigation; a `<extensionId>:<viewId>` key addresses any view.
 */
export function resolveSidebarViewKey(
  views: readonly SessionSidebarView[],
  callerExtensionId: string,
  viewId: string,
): string | undefined {
  const candidates = viewId.includes(":")
    ? [viewId]
    : [`${callerExtensionId}:${viewId}`, viewId === "files" ? bundledSidebarViewKey() : viewId];

  for (const candidate of candidates) {
    if (views.some((view) => view.key === candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/** One pane the layout decided to draw, at its resolved width. */
export interface SidebarPanePlan {
  view: SessionSidebarView;
  width: number;
}

/** The panes that fit this frame, split by side, plus the columns they consume. */
export interface SidebarLayoutPlan {
  left: SidebarPanePlan[];
  right: SidebarPanePlan[];
  /** Total columns used by panes and their dividers, both sides. */
  totalWidth: number;
  /** Columns consumed left of the review stream (left panes plus dividers). */
  leftWidth: number;
}

export interface PlanSidebarLayoutOptions {
  views: readonly SessionSidebarView[];
  openKeys: readonly string[];
  /** Per-view preferred widths from user resizes; absent views use the default. */
  widths: Readonly<Record<string, number>>;
  defaultWidth: number;
  minWidth: number;
  dividerWidth: number;
  /** Columns available for panes plus the review stream. */
  bodyWidth: number;
  /** Columns the review stream may never drop below. */
  diffMinWidth: number;
}

/**
 * Decide which open panes fit and at what width.
 *
 * Panes are considered in view order — bundled first, then registration
 * order — and each takes its preferred width, shrinking to what remains once
 * the review stream's minimum is reserved. A pane that cannot get its minimum
 * is skipped rather than squeezing the ones before it, so a narrow terminal
 * degrades by dropping the latest-registered panes first.
 */
export function planSidebarLayout(options: PlanSidebarLayoutOptions): SidebarLayoutPlan {
  const open = new Set(options.openKeys);
  const left: SidebarPanePlan[] = [];
  const right: SidebarPanePlan[] = [];
  let used = 0;

  for (const view of options.views) {
    if (!open.has(view.key)) {
      continue;
    }

    const preferred = options.widths[view.key] ?? options.defaultWidth;
    const remaining = options.bodyWidth - options.diffMinWidth - used - options.dividerWidth;
    const width = Math.min(Math.max(preferred, options.minWidth), remaining);
    if (width < options.minWidth) {
      continue;
    }

    used += width + options.dividerWidth;
    (view.placement === "right" ? right : left).push({ view, width });
  }

  const leftWidth = left.reduce((sum, pane) => sum + pane.width + options.dividerWidth, 0);
  return { left, right, totalWidth: used, leftWidth };
}
