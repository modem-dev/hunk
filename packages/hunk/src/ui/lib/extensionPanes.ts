import { paneKey, resolveExtensionPanes } from "../../extensions/apply";
import { getBundledUIRegistry } from "../../extensions/default/ui";
import { HUNK_FILES_PANE_KEY } from "../../extensions/extensionIds";
import type {
  ExtensionCurrentLinePaint,
  ExtensionPaneAvailabilityContext,
  ExtensionPanePlacement,
} from "../../extension-api/types";
import { extensionPaneSize } from "../../extensions/panes";
import type { ExtensionLoadResult, RegisteredPane } from "../../extensions/types";

/** One cell reserved between each resizable pane and its neighbor. */
export const EXTENSION_PANE_DIVIDER_SIZE = 1;
/** Smallest review height preserved while edge panes are open or resized. */
export const MIN_EXTENSION_REVIEW_HEIGHT = 5;

/** One pane offered to a review session. */
export interface SessionPane {
  key: string;
  registered: RegisteredPane;
  placement: ExtensionPanePlacement;
  title: string;
  defaultOpen: boolean;
}

/** Compose bundled UI panes before user panes, preserving stable keys and replacement defaults. */
export function buildSessionPanes(extensions: ExtensionLoadResult | undefined): SessionPane[] {
  const all = resolveExtensionPanes({
    panes: [...getBundledUIRegistry().panes, ...(extensions?.registry.panes ?? [])],
  }).panes;
  const replacements = new Set(all.map((entry) => entry.pane.replaces).filter(Boolean));
  return all.map((registered) => {
    const key = paneKey(registered);
    const pane = registered.pane;
    return {
      key,
      registered,
      placement: pane.placement ?? "left",
      title: pane.title ?? pane.id,
      defaultOpen:
        !replacements.has(key) &&
        (key === HUNK_FILES_PANE_KEY || pane.defaultOpen === true || pane.replaces !== undefined),
    };
  });
}

export interface PaneOpenState {
  known: readonly string[];
  open: readonly string[];
}

/** Initialize logical pane preferences from registrations. */
export function initialPaneOpenState(panes: readonly SessionPane[]): PaneOpenState {
  return {
    known: panes.map((pane) => pane.key),
    open: panes.filter((pane) => pane.defaultOpen).map((pane) => pane.key),
  };
}

/** Reconcile registrations without overwriting choices for known pane keys. */
export function reconcilePaneOpenState(
  panes: readonly SessionPane[],
  state: PaneOpenState,
): PaneOpenState {
  const keys = panes.map((pane) => pane.key);
  const known = new Set(state.known);
  const open = new Set(state.open);
  const nextOpen = panes
    .filter((pane) => (known.has(pane.key) ? open.has(pane.key) : pane.defaultOpen))
    .map((pane) => pane.key);
  if (
    keys.length === state.known.length &&
    keys.every((key, index) => state.known[index] === key) &&
    nextOpen.length === state.open.length &&
    nextOpen.every((key, index) => state.open[index] === key)
  )
    return state;
  return { known: keys, open: nextOpen };
}

/** Resolve the pane currently filling a named slot, preserving an open fallback. */
export function resolvePaneSlotKey(options: {
  panes: readonly SessionPane[];
  slotKey: string;
  openKeys: readonly string[];
  quarantined?: WeakSet<RegisteredPane>;
}): string {
  const open = new Set(options.openKeys);
  const replacementByTarget = new Map<string, SessionPane>();
  for (const pane of options.panes) {
    const target = pane.registered.pane.replaces;
    if (target && !options.quarantined?.has(pane.registered)) {
      // Pane resolution admits one replacement per target, so every named slot
      // has at most one owner at each step of a replacement chain.
      replacementByTarget.set(target, pane);
    }
  }

  const replacements: SessionPane[] = [];
  const visited = new Set<string>();
  let target = options.slotKey;
  while (!visited.has(target)) {
    visited.add(target);
    const replacement = replacementByTarget.get(target);
    if (!replacement) break;
    replacements.push(replacement);
    target = replacement.key;
  }

  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    if (replacement && open.has(replacement.key)) return replacement.key;
  }
  if (open.has(options.slotKey)) return options.slotKey;
  return replacements.at(-1)?.key ?? options.slotKey;
}

/** Resolve a bare local id or a fully qualified pane key. */
export function resolvePaneKey(
  panes: readonly SessionPane[],
  extensionId: string,
  id: string,
): string | undefined {
  const key = id.includes(":") ? id : `${extensionId}:${id}`;
  return panes.some((pane) => pane.key === key) ? key : undefined;
}

export interface PaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PlannedPane {
  pane: SessionPane;
  bounds: PaneBounds;
  divider?: PaneBounds;
}
export interface ExtensionPaneLayoutPlan {
  panes: readonly PlannedPane[];
  reviewBounds: PaneBounds;
  omittedKeys: readonly string[];
}

export interface PlanExtensionPanesOptions {
  panes: readonly SessionPane[];
  /** Pane keys accepted by logical state and commit-phase availability probing. */
  openKeys: readonly string[];
  sizes: Readonly<Record<string, number>>;
  bodyWidth: number;
  bodyHeight: number;
  minReviewWidth: number;
  minReviewHeight: number;
}

export interface PaneAvailabilityFailure {
  pane: SessionPane;
  error: unknown;
}

export interface PaneAvailabilityProbe {
  available: ReadonlySet<RegisteredPane>;
  failures: readonly PaneAvailabilityFailure[];
}

/** Probe extension availability without mutating host state or reporting failures. */
export function probeExtensionPaneAvailability({
  panes,
  context,
  currentLine,
  retainCurrentLineRegistrations,
}: {
  panes: readonly SessionPane[];
  context: Omit<ExtensionPaneAvailabilityContext, "placement" | "currentLine">;
  currentLine: ExtensionCurrentLinePaint | null;
  retainCurrentLineRegistrations?: ReadonlySet<RegisteredPane>;
}): PaneAvailabilityProbe {
  const available = new Set<RegisteredPane>();
  const failures: PaneAvailabilityFailure[] = [];

  for (const pane of panes) {
    const registration = pane.registered.pane;
    if (registration.currentLine && retainCurrentLineRegistrations?.has(pane.registered)) {
      available.add(pane.registered);
      continue;
    }
    if (!registration.available) {
      available.add(pane.registered);
      continue;
    }
    try {
      const result = registration.available({
        ...context,
        placement: pane.placement,
        currentLine: registration.currentLine ? currentLine : null,
      });
      if (typeof result !== "boolean") {
        throw new Error("available() must return a boolean synchronously");
      }
      if (result) available.add(pane.registered);
    } catch (error) {
      failures.push({ pane, error });
    }
  }

  return { available, failures };
}

/** Plan exact rectangles without invoking extension code or mutating host state. */
export function planExtensionPanes(options: PlanExtensionPanesOptions): ExtensionPaneLayoutPlan {
  const open = new Set(options.openKeys);
  const omittedKeys: string[] = [];
  const accepted = options.panes.filter((pane) => open.has(pane.key));

  let left = 0;
  let right = Math.max(0, options.bodyWidth);
  let top = 0;
  let bottom = Math.max(0, options.bodyHeight);
  const planned = new Map<string, PlannedPane>();

  const sizeSpec = (pane: SessionPane) => {
    const spec = extensionPaneSize(pane.registered.pane, pane.placement);
    const min = spec.min ?? 1;
    const max = spec.max ?? Number.MAX_SAFE_INTEGER;
    const axisSize =
      pane.placement === "left" || pane.placement === "right"
        ? Math.max(0, options.bodyWidth)
        : Math.max(0, options.bodyHeight);
    const automaticSize =
      spec.fraction === undefined ? spec.preferred : Math.round(axisSize * spec.fraction);
    return {
      target: options.sizes[pane.key] ?? automaticSize,
      min,
      max,
      fixed: min === max,
    };
  };

  for (const pane of accepted.filter(
    (pane) => pane.placement === "left" || pane.placement === "right",
  )) {
    const spec = sizeSpec(pane);
    const dividerSize = spec.fixed ? 0 : EXTENSION_PANE_DIVIDER_SIZE;
    const remaining = right - left - options.minReviewWidth - dividerSize;
    const width = Math.min(Math.max(spec.target, spec.min), spec.max, remaining);
    if (width < spec.min) {
      omittedKeys.push(pane.key);
      continue;
    }
    if (pane.placement === "left") {
      const bounds = { x: left, y: 0, width, height: options.bodyHeight };
      const divider = dividerSize
        ? {
            x: left + width,
            y: 0,
            width: EXTENSION_PANE_DIVIDER_SIZE,
            height: options.bodyHeight,
          }
        : undefined;
      planned.set(pane.key, { pane, bounds, ...(divider ? { divider } : {}) });
      left += width + dividerSize;
    } else {
      const bounds = { x: right - width, y: 0, width, height: options.bodyHeight };
      const divider = dividerSize
        ? {
            x: right - width - EXTENSION_PANE_DIVIDER_SIZE,
            y: 0,
            width: EXTENSION_PANE_DIVIDER_SIZE,
            height: options.bodyHeight,
          }
        : undefined;
      planned.set(pane.key, { pane, bounds, ...(divider ? { divider } : {}) });
      right -= width + dividerSize;
    }
  }

  for (const pane of accepted.filter(
    (pane) => pane.placement === "top" || pane.placement === "bottom",
  )) {
    const spec = sizeSpec(pane);
    const dividerSize = spec.fixed ? 0 : EXTENSION_PANE_DIVIDER_SIZE;
    const remaining = bottom - top - options.minReviewHeight - dividerSize;
    const height = Math.min(Math.max(spec.target, spec.min), spec.max, remaining);
    if (height < spec.min) {
      omittedKeys.push(pane.key);
      continue;
    }
    if (pane.placement === "top") {
      const bounds = { x: left, y: top, width: right - left, height };
      const divider = dividerSize
        ? {
            x: left,
            y: top + height,
            width: right - left,
            height: EXTENSION_PANE_DIVIDER_SIZE,
          }
        : undefined;
      planned.set(pane.key, { pane, bounds, ...(divider ? { divider } : {}) });
      top += height + dividerSize;
    } else {
      const bounds = { x: left, y: bottom - height, width: right - left, height };
      const divider = dividerSize
        ? {
            x: left,
            y: bottom - height - EXTENSION_PANE_DIVIDER_SIZE,
            width: right - left,
            height: EXTENSION_PANE_DIVIDER_SIZE,
          }
        : undefined;
      planned.set(pane.key, { pane, bounds, ...(divider ? { divider } : {}) });
      bottom -= height + dividerSize;
    }
  }

  return {
    panes: options.panes.flatMap((pane) => {
      const entry = planned.get(pane.key);
      return entry ? [entry] : [];
    }),
    reviewBounds: {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    },
    omittedKeys,
  };
}
