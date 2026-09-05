/**
 * Coordinates extension panes as users open, resize, hide, and recover them around the review.
 *
 * Extension commands and the built-in files toggle share logical open choices, while responsive
 * layout only controls whether side panes can occupy terminal space. The controller probes
 * extension availability after commit, quarantines callback or render failures by registration
 * identity, restores the built-in files pane after a failed replacement, and retains current-line
 * panes while the review renderer prepares fresh paint.
 *
 * App supplies terminal geometry, review facts, and capability leases and retains pane rendering.
 * The controller owns pane state and exact layout; it never recreates extension authority or
 * invokes extension code while React renders.
 */

import { MouseButton, type MouseEvent as TuiMouseEvent } from "@opentui/core";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SidebarVisibility } from "../../core/run/commandInputs";
import type {
  ExtensionCurrentLinePaint,
  ExtensionPaneAvailabilityContext,
  ExtensionPaneControls,
} from "../../extension-api/types";
import { HUNK_FILES_PANE_KEY } from "../../extensions/extensionIds";
import { extensionPaneSize } from "../../extensions/panes";
import type { ExtensionLoadResult, RegisteredPane } from "../../extensions/types";
import type { ExtensionCapabilityLease } from "../lib/extensionCapabilityLease";
import {
  applyExtensionCurrentLinePaintUpdate,
  extensionCurrentLinePaintMatchesCursor,
  type ExtensionCurrentLinePaintState,
  type ExtensionCurrentLinePaintUpdate,
} from "../lib/extensionCurrentLine";
import {
  buildSessionPanes,
  initialPaneOpenState,
  planExtensionPanes,
  probeExtensionPaneAvailability,
  reconcilePaneOpenState,
  resolvePaneKey,
  resolvePaneSlotKey,
  type ExtensionPaneLayoutPlan,
  type PaneOpenState,
  type PlannedPane,
  type SessionPane,
} from "../lib/extensionPanes";
import { resizeSidebarWidth } from "../lib/sidebar";

type PaneResizeAxis = "width" | "height";

interface PaneSizeOverride {
  axis: PaneResizeAxis;
  size: number;
}

interface PaneResizeState {
  key: string;
  registered: RegisteredPane;
  placement: SessionPane["placement"];
  origin: number;
  startSize: number;
  maxSize: number;
  minSize: number;
}

interface AvailabilityRequest {
  panes: readonly SessionPane[];
  context: Omit<ExtensionPaneAvailabilityContext, "placement" | "currentLine">;
  currentLine: ExtensionCurrentLinePaint | null;
  retainCurrentLineRegistrations?: ReadonlySet<RegisteredPane>;
}

interface AvailabilitySnapshot {
  request: AvailabilityRequest | null;
  available: ReadonlySet<RegisteredPane>;
}

export interface ExtensionPaneController {
  beginPaneResize: (planned: PlannedPane, event: TuiMouseEvent) => boolean;
  createPaneControls: (extensionId: string) => ExtensionPaneControls;
  currentLinePaint: ExtensionCurrentLinePaint | null;
  currentLinePaintRequested: boolean;
  endPaneResize: (event?: TuiMouseEvent) => void;
  filesPaneVisible: boolean;
  onCurrentLinePaintChange: (update: ExtensionCurrentLinePaintUpdate) => void;
  paneLayout: ExtensionPaneLayoutPlan;
  reportPaneRenderFailure: (pane: SessionPane) => void;
  renderSidebar: boolean;
  resizingPaneKey: string | null;
  toggleFilesPane: () => void;
  updatePaneResize: (event: TuiMouseEvent) => void;
}

/** Initialize pane choices while applying the launch-time files-pane preference to its active slot. */
function initialOpenState(
  panes: readonly SessionPane[],
  initialSidebar: SidebarVisibility | undefined,
): PaneOpenState {
  const initial = initialPaneOpenState(panes);
  if (initialSidebar !== false) return initial;
  const filesPaneKey = resolvePaneSlotKey({
    panes,
    slotKey: HUNK_FILES_PANE_KEY,
    openKeys: initial.open,
  });
  return { ...initial, open: initial.open.filter((key) => key !== filesPaneKey) };
}

/** Return whether one captured drag still owns the exact committed divider. */
function activeResizePane(
  resize: PaneResizeState,
  layout: ExtensionPaneLayoutPlan,
): PlannedPane | undefined {
  return layout.panes.find(
    (planned) =>
      planned.pane.key === resize.key &&
      planned.pane.registered === resize.registered &&
      planned.pane.placement === resize.placement &&
      planned.divider !== undefined,
  );
}

/** Format one contained availability failure for the extension warning channel. */
function availabilityFailureMessage(pane: SessionPane, error: unknown): string {
  return `Extension ${pane.registered.extensionId} pane "${pane.registered.pane.id}" availability failed • ${error instanceof Error ? error.message : String(error)}`;
}

/** Own pane preferences, availability, recovery, responsive reveal, and resize transitions. */
export function useExtensionPaneController({
  availabilityContext,
  bodyHeight,
  bodyWidth,
  canForceShowSidebar,
  createReviewCapabilityLease,
  currentLineCursor,
  extensions,
  initialSidebar,
  minReviewHeight,
  minReviewWidth,
  notifyWarning,
  pagerMode,
  responsiveShowsSidebar,
}: {
  availabilityContext: Omit<ExtensionPaneAvailabilityContext, "placement" | "currentLine">;
  bodyHeight: number;
  bodyWidth: number;
  canForceShowSidebar: boolean;
  createReviewCapabilityLease: () => ExtensionCapabilityLease;
  currentLineCursor: { fileId: string; stableKey: string } | null;
  extensions: ExtensionLoadResult | undefined;
  initialSidebar: SidebarVisibility | undefined;
  minReviewHeight: number;
  minReviewWidth: number;
  notifyWarning: (message: string) => void;
  pagerMode: boolean;
  responsiveShowsSidebar: boolean;
}): ExtensionPaneController {
  const sessionPanes = useMemo(() => buildSessionPanes(extensions), [extensions]);
  const [paneOpenState, setPaneOpenState] = useState(() =>
    initialOpenState(sessionPanes, initialSidebar),
  );
  const [paneSizeOverrides, setPaneSizeOverrides] = useState<Record<string, PaneSizeOverride>>({});
  const [paneResize, setPaneResize] = useState<PaneResizeState | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(() => !pagerMode);
  const [forceSidebarOpen, setForceSidebarOpen] = useState(
    () => !pagerMode && initialSidebar === true,
  );
  const [currentLinePaintState, setCurrentLinePaintState] =
    useState<ExtensionCurrentLinePaintState>({
      status: "unavailable",
      fileId: null,
      cursorKey: null,
      paint: null,
    });
  const [paneFailureEpoch, setPaneFailureEpoch] = useState(0);
  const [availabilitySnapshot, setAvailabilitySnapshot] = useState<AvailabilitySnapshot>({
    request: null,
    available: new Set(),
  });

  const sessionPanesRef = useRef(sessionPanes);
  const paneOpenStateRef = useRef(paneOpenState);
  const paneLayoutRef = useRef<ExtensionPaneLayoutPlan | null>(null);
  const paneResizeRef = useRef<PaneResizeState | null>(null);
  const responsiveRef = useRef({ canForceShowSidebar, responsiveShowsSidebar });
  const retainedCurrentLinePaneRegistrationsRef = useRef<ReadonlySet<RegisteredPane>>(new Set());
  const quarantinedRef = useRef(new WeakSet<RegisteredPane>());
  const reportedAvailabilityFailuresRef = useRef(new WeakSet<RegisteredPane>());
  const lastAvailabilityProbeRef = useRef<{
    request: AvailabilityRequest;
    available: ReadonlySet<RegisteredPane>;
  } | null>(null);

  // Reconcile registrations before committed controls can observe the new pane set.
  const committedPaneOpenState = useMemo(
    () => reconcilePaneOpenState(sessionPanes, paneOpenState),
    [paneOpenState, sessionPanes],
  );

  // Publish pane and responsive facts only after the matching render commits.
  useLayoutEffect(() => {
    sessionPanesRef.current = sessionPanes;
    paneOpenStateRef.current = committedPaneOpenState;
    responsiveRef.current = { canForceShowSidebar, responsiveShowsSidebar };
    if (committedPaneOpenState !== paneOpenState) setPaneOpenState(committedPaneOpenState);
  }, [
    canForceShowSidebar,
    committedPaneOpenState,
    paneOpenState,
    responsiveShowsSidebar,
    sessionPanes,
  ]);

  const currentLinePaintMatchesCursor = extensionCurrentLinePaintMatchesCursor(
    currentLinePaintState,
    currentLineCursor,
  );
  const currentLinePaint = currentLinePaintMatchesCursor ? currentLinePaintState.paint : null;
  const currentLinePaintPending =
    currentLinePaintState.status === "pending" ||
    (currentLinePaintState.status === "ready" && !currentLinePaintMatchesCursor);
  const currentLinePaintRequested = sessionPanes.some(
    (pane) =>
      committedPaneOpenState.open.includes(pane.key) && pane.registered.pane.currentLine === true,
  );

  const onCurrentLinePaintChange = useCallback((update: ExtensionCurrentLinePaintUpdate) => {
    setCurrentLinePaintState((current) => applyExtensionCurrentLinePaintUpdate(current, update));
  }, []);

  // Opening a side pane reveals its terminal area when responsive layout allows it.
  const revealSidebarArea = useCallback(() => {
    setSidebarVisible(true);
    const responsive = responsiveRef.current;
    if (!responsive.responsiveShowsSidebar && responsive.canForceShowSidebar) {
      setForceSidebarOpen(true);
    }
  }, []);

  const cancelResize = useCallback((key?: string) => {
    const active = paneResizeRef.current;
    if (!active || (key && active.key !== key)) return;
    paneResizeRef.current = null;
    setPaneResize(null);
  }, []);

  // Update logical open state and cancel any drag owned by a pane being closed.
  const setPaneOpen = useCallback(
    (key: string, nextOpen: boolean | "toggle") => {
      const committedOpen = paneOpenStateRef.current.open.includes(key);
      const committedNext = nextOpen === "toggle" ? !committedOpen : nextOpen;
      if (!committedNext) cancelResize(key);
      setPaneOpenState((current) => {
        const reconciled = reconcilePaneOpenState(sessionPanesRef.current, current);
        const isOpen = reconciled.open.includes(key);
        const resolved = nextOpen === "toggle" ? !isOpen : nextOpen;
        if (resolved === isOpen) return reconciled;
        return {
          known: reconciled.known,
          open: resolved
            ? [...reconciled.open, key]
            : reconciled.open.filter((open) => open !== key),
        };
      });
    },
    [cancelResize],
  );

  // Give each extension controls scoped to its own panes and current review lease.
  const createPaneControls = useCallback(
    (extensionId: string): ExtensionPaneControls => {
      const lease = createReviewCapabilityLease();
      const hasAuthority = (method: string) => {
        if (lease.isLive()) return true;
        notifyWarning(
          `Extension ${extensionId} ${method} ignored — the review session was reloaded`,
        );
        return false;
      };
      const resolve = (method: string, id: string) => {
        const key = resolvePaneKey(sessionPanesRef.current, extensionId, id);
        if (!key) {
          notifyWarning(`Extension ${extensionId} ${method} targeted unknown pane "${id}"`);
        }
        return key;
      };
      const revealIfSide = (key: string) => {
        const pane = sessionPanesRef.current.find((entry) => entry.key === key);
        if (pane?.placement === "left" || pane?.placement === "right") revealSidebarArea();
      };
      return {
        open(id) {
          if (!hasAuthority("panes.open")) return;
          const key = resolve("panes.open", id);
          if (!key) return;
          setPaneOpen(key, true);
          revealIfSide(key);
        },
        close(id) {
          if (!hasAuthority("panes.close")) return;
          const key = resolve("panes.close", id);
          if (key) setPaneOpen(key, false);
        },
        toggle(id) {
          if (!hasAuthority("panes.toggle")) return;
          const key = resolve("panes.toggle", id);
          if (!key) return;
          const opens = !paneOpenStateRef.current.open.includes(key);
          setPaneOpen(key, "toggle");
          if (opens) revealIfSide(key);
        },
        isOpen(id) {
          if (!lease.isLive()) return false;
          const key = resolvePaneKey(sessionPanesRef.current, extensionId, id);
          return key !== undefined && paneOpenStateRef.current.open.includes(key);
        },
      };
    },
    [createReviewCapabilityLease, notifyWarning, revealSidebarArea, setPaneOpen],
  );

  const sidebarAreaVisible =
    sidebarVisible && (responsiveShowsSidebar || (forceSidebarOpen && canForceShowSidebar));
  const failedFilesReplacement = sessionPanes.some(
    (pane) =>
      committedPaneOpenState.open.includes(pane.key) &&
      pane.registered.pane.replaces === HUNK_FILES_PANE_KEY &&
      quarantinedRef.current.has(pane.registered),
  );
  const effectiveOpenPaneKeys = committedPaneOpenState.open.filter((key) => {
    const pane = sessionPanes.find((entry) => entry.key === key);
    return sidebarAreaVisible || (pane?.placement !== "left" && pane?.placement !== "right");
  });
  if (
    failedFilesReplacement &&
    sidebarAreaVisible &&
    !effectiveOpenPaneKeys.includes(HUNK_FILES_PANE_KEY)
  ) {
    effectiveOpenPaneKeys.push(HUNK_FILES_PANE_KEY);
  }

  const candidatePanes = sessionPanes.filter(
    (pane) =>
      effectiveOpenPaneKeys.includes(pane.key) && !quarantinedRef.current.has(pane.registered),
  );
  const availabilityRequest = useMemo<AvailabilityRequest>(
    () => ({
      panes: candidatePanes,
      context: availabilityContext,
      currentLine: currentLinePaint,
      ...(currentLinePaintPending
        ? {
            retainCurrentLineRegistrations: retainedCurrentLinePaneRegistrationsRef.current,
          }
        : {}),
    }),
    [
      availabilityContext.review,
      availabilityContext.files,
      availabilityContext.selectedFileId,
      availabilityContext.selectedHunkIndex,
      currentLinePaint,
      currentLinePaintPending,
      effectiveOpenPaneKeys.join("\0"),
      paneFailureEpoch,
      sessionPanes,
    ],
  );

  // Probe availability after commit and quarantine callbacks that throw.
  useLayoutEffect(() => {
    let available: ReadonlySet<RegisteredPane>;
    const cached = lastAvailabilityProbeRef.current;
    if (cached?.request === availabilityRequest) {
      available = cached.available;
    } else {
      const probe = probeExtensionPaneAvailability(availabilityRequest);
      available = probe.available;
      for (const failure of probe.failures) {
        quarantinedRef.current.add(failure.pane.registered);
        if (!reportedAvailabilityFailuresRef.current.has(failure.pane.registered)) {
          reportedAvailabilityFailuresRef.current.add(failure.pane.registered);
          notifyWarning(availabilityFailureMessage(failure.pane, failure.error));
        }
      }
      lastAvailabilityProbeRef.current = { request: availabilityRequest, available };
    }
    setAvailabilitySnapshot((current) =>
      current.request === availabilityRequest && current.available === available
        ? current
        : { request: availabilityRequest, available },
    );
  }, [availabilityRequest, notifyWarning]);

  // Keep accepted current-line panes mounted while fresh paint is being prepared.
  const acceptedOpenPaneKeys = effectiveOpenPaneKeys.filter((key) => {
    const pane = sessionPanes.find((entry) => entry.key === key);
    if (!pane || quarantinedRef.current.has(pane.registered)) return false;
    if (
      currentLinePaintPending &&
      retainedCurrentLinePaneRegistrationsRef.current.has(pane.registered)
    ) {
      return true;
    }
    if (!pane.registered.pane.available) return true;
    return (
      availabilitySnapshot.request === availabilityRequest &&
      availabilitySnapshot.available.has(pane.registered)
    );
  });

  // A same-key reload may move a pane between axes; never reinterpret columns as rows.
  const paneSizes = useMemo(() => {
    const sizes: Record<string, number> = {};
    for (const pane of sessionPanes) {
      const override = paneSizeOverrides[pane.key];
      const axis: PaneResizeAxis =
        pane.placement === "left" || pane.placement === "right" ? "width" : "height";
      if (override?.axis === axis) sizes[pane.key] = override.size;
    }
    return sizes;
  }, [paneSizeOverrides, sessionPanes]);

  // Compute geometry from accepted panes only; extension callbacks never run here.
  const paneLayout = useMemo(
    () =>
      planExtensionPanes({
        panes: sessionPanes,
        openKeys: acceptedOpenPaneKeys,
        sizes: paneSizes,
        bodyWidth,
        bodyHeight,
        minReviewWidth,
        minReviewHeight,
      }),
    [
      acceptedOpenPaneKeys.join("\0"),
      bodyHeight,
      bodyWidth,
      minReviewHeight,
      minReviewWidth,
      paneSizes,
      sessionPanes,
    ],
  );

  useLayoutEffect(() => {
    paneLayoutRef.current = paneLayout;
    paneResizeRef.current = paneResize;
    if (paneResize && !activeResizePane(paneResize, paneLayout)) cancelResize();
  }, [cancelResize, paneLayout, paneResize]);

  useLayoutEffect(() => {
    if (currentLinePaintPending) return;
    retainedCurrentLinePaneRegistrationsRef.current = new Set(
      paneLayout.panes
        .filter(({ pane }) => pane.registered.pane.currentLine === true)
        .map(({ pane }) => pane.registered),
    );
  }, [currentLinePaintPending, paneLayout]);

  // Toggle the active files slot, including the built-in fallback for a failed replacement.
  const toggleFilesPane = useCallback(() => {
    const panes = sessionPanesRef.current;
    const logicalOpenKeys = paneOpenStateRef.current.open;
    const visibleKeys = paneLayoutRef.current?.panes.map(({ pane }) => pane.key) ?? [];
    const visibleFilesPaneKey = resolvePaneSlotKey({
      panes,
      slotKey: HUNK_FILES_PANE_KEY,
      openKeys: visibleKeys,
      quarantined: quarantinedRef.current,
    });
    if (
      visibleKeys.includes(visibleFilesPaneKey) &&
      visibleFilesPaneKey === HUNK_FILES_PANE_KEY &&
      !logicalOpenKeys.includes(HUNK_FILES_PANE_KEY)
    ) {
      const failedReplacement = panes.find(
        (pane) =>
          logicalOpenKeys.includes(pane.key) &&
          pane.registered.pane.replaces === HUNK_FILES_PANE_KEY &&
          quarantinedRef.current.has(pane.registered),
      );
      if (failedReplacement) {
        setPaneOpen(failedReplacement.key, false);
        return;
      }
    }

    const filesPaneKey = resolvePaneSlotKey({
      panes,
      slotKey: HUNK_FILES_PANE_KEY,
      openKeys: logicalOpenKeys,
      quarantined: quarantinedRef.current,
    });
    const filesPane = panes.find((pane) => pane.key === filesPaneKey);
    const usesSidebarArea = filesPane?.placement === "left" || filesPane?.placement === "right";
    const responsive = responsiveRef.current;
    const areaVisible =
      sidebarVisible &&
      (responsive.responsiveShowsSidebar || (forceSidebarOpen && responsive.canForceShowSidebar));
    if (usesSidebarArea && !areaVisible) {
      setPaneOpen(filesPaneKey, true);
      revealSidebarArea();
      return;
    }
    setPaneOpen(filesPaneKey, "toggle");
  }, [forceSidebarOpen, revealSidebarArea, setPaneOpen, sidebarVisible]);

  // Quarantine a pane that failed to render and restore the built-in files pane if needed.
  const reportPaneRenderFailure = useCallback(
    (pane: SessionPane) => {
      quarantinedRef.current.add(pane.registered);
      cancelResize(pane.key);
      if (pane.registered.pane.replaces === HUNK_FILES_PANE_KEY) {
        setPaneOpen(pane.key, false);
        setPaneOpen(HUNK_FILES_PANE_KEY, true);
        revealSidebarArea();
      }
      setPaneFailureEpoch((value) => value + 1);
    },
    [cancelResize, revealSidebarArea, setPaneOpen],
  );

  // Start a drag only for the divider still owned by this exact pane registration.
  const beginPaneResize = useCallback(
    (planned: PlannedPane, event: TuiMouseEvent): boolean => {
      if (event.button !== MouseButton.LEFT || !planned.divider) return false;
      const committed = paneLayoutRef.current?.panes.find(
        (entry) =>
          entry.pane.key === planned.pane.key &&
          entry.pane.registered === planned.pane.registered &&
          entry.pane.placement === planned.pane.placement &&
          entry.divider !== undefined,
      );
      if (!committed) return false;
      const vertical = committed.pane.placement === "left" || committed.pane.placement === "right";
      const spec = extensionPaneSize(committed.pane.registered.pane, committed.pane.placement);
      const currentSize = vertical ? committed.bounds.width : committed.bounds.height;
      const layout = paneLayoutRef.current!;
      const resize: PaneResizeState = {
        key: committed.pane.key,
        registered: committed.pane.registered,
        placement: committed.pane.placement,
        origin: vertical ? event.x : event.y,
        startSize: currentSize,
        maxSize: Math.min(
          spec.max ?? Number.MAX_SAFE_INTEGER,
          currentSize +
            Math.max(
              0,
              vertical
                ? layout.reviewBounds.width - minReviewWidth
                : layout.reviewBounds.height - minReviewHeight,
            ),
        ),
        minSize: spec.min ?? 1,
      };
      paneResizeRef.current = resize;
      setPaneResize(resize);
      event.preventDefault();
      event.stopPropagation();
      return true;
    },
    [minReviewHeight, minReviewWidth],
  );

  // Resize along the pane's axis while preserving the review's minimum bounds.
  const updatePaneResize = useCallback(
    (event: TuiMouseEvent) => {
      const resize = paneResizeRef.current;
      const layout = paneLayoutRef.current;
      if (!resize || !layout) return;
      const planned = activeResizePane(resize, layout);
      if (!planned) {
        cancelResize();
        return;
      }
      const vertical = resize.placement === "left" || resize.placement === "right";
      const currentSize = vertical ? planned.bounds.width : planned.bounds.height;
      const currentMax =
        currentSize +
        Math.max(
          0,
          vertical
            ? layout.reviewBounds.width - minReviewWidth
            : layout.reviewBounds.height - minReviewHeight,
        );
      const position = vertical ? event.x : event.y;
      const inverted = resize.placement === "right" || resize.placement === "bottom";
      const next = inverted
        ? resizeSidebarWidth(
            resize.startSize,
            position,
            resize.origin,
            resize.minSize,
            Math.min(resize.maxSize, currentMax),
          )
        : resizeSidebarWidth(
            resize.startSize,
            resize.origin,
            position,
            resize.minSize,
            Math.min(resize.maxSize, currentMax),
          );
      const axis: PaneResizeAxis = vertical ? "width" : "height";
      setPaneSizeOverrides((current) => {
        const previous = current[resize.key];
        return previous?.axis === axis && previous.size === next
          ? current
          : { ...current, [resize.key]: { axis, size: next } };
      });
      event.preventDefault();
      event.stopPropagation();
    },
    [cancelResize, minReviewHeight, minReviewWidth],
  );

  // End the active drag and release mouse event ownership.
  const endPaneResize = useCallback((event?: TuiMouseEvent) => {
    if (!paneResizeRef.current) return;
    paneResizeRef.current = null;
    setPaneResize(null);
    event?.preventDefault();
    event?.stopPropagation();
  }, []);

  const visiblePaneKeys = paneLayout.panes.map(({ pane }) => pane.key);
  const visibleFilesPaneKey = resolvePaneSlotKey({
    panes: sessionPanes,
    slotKey: HUNK_FILES_PANE_KEY,
    openKeys: visiblePaneKeys,
    quarantined: quarantinedRef.current,
  });

  return {
    beginPaneResize,
    createPaneControls,
    currentLinePaint,
    currentLinePaintRequested,
    endPaneResize,
    filesPaneVisible: visiblePaneKeys.includes(visibleFilesPaneKey),
    onCurrentLinePaintChange,
    paneLayout,
    reportPaneRenderFailure,
    renderSidebar: paneLayout.panes.some(
      ({ pane }) => pane.placement === "left" || pane.placement === "right",
    ),
    resizingPaneKey: paneResize?.key ?? null,
    toggleFilesPane,
    updatePaneResize,
  };
}
