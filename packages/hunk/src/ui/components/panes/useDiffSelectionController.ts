/** Owns persistent diff-selection interaction while consuming DiffPane's canonical geometry. */
import {
  MouseButton,
  type MouseEvent as TuiMouseEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import { useRenderer } from "@opentui/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ReviewNoteTargetV1 } from "../../../core/review/types";
import { resolveSplitPaneWidths } from "../../diff/codeColumns";
import { isNestedRowMouseAction } from "../../diff/rowMouseActions";
import { contextLineStableKeySides } from "../../diff/reviewRenderPlan";
import type { LineCursor, LineCursorBoundsLookup } from "../../lib/lineCursors";
import { setMouseCapture } from "../../lib/mouseCapture";
import {
  buildCopySelectedRowKeys,
  clampCopyColumn,
  copySelectionDragIsClick,
  copySelectionPointsEqual,
  copySelectionPointsShareRow,
  expandSelectionPoint,
  findCopySelectionPoint,
  findLineCursorForClick,
  normalizeCopySelectionRange,
  planSelectionActionBar,
  projectCommentSelection,
  renderCopySelectionText,
  resolveCopySelectionSide,
  type CopySelectionContext,
  type CopySelectionDrag,
  type CopySelectionPoint,
  type CopySelectionSide,
} from "./copySelection";
import type { SelectionActionBarViewModel } from "./SelectionActionBar";

const SELECTION_ACTION_BAR_WIDTH = 34;

/** Commands App may route to the pane's active persistent selection. */
export interface ReviewSelectionActionsHandle {
  hasSelection: () => boolean;
  beginKeyboardSelection: () => boolean;
  copy: () => boolean;
  comment: () => boolean;
  clear: () => boolean;
  move: (delta: number) => boolean;
}

interface UseDiffSelectionControllerOptions {
  cancelCopySelectionRef?: RefObject<(() => void) | null>;
  selectionActionsRef?: RefObject<ReviewSelectionActionsHandle | null>;
  selectionGeometryKey: string;
  context: CopySelectionContext;
  effectiveScrollTop: number;
  height?: number;
  lineCursorBoundsOf: LineCursorBoundsLookup;
  lineCursors: LineCursor[];
  onCopyFeedback?: (text: string) => void;
  onCopySelectionText?: (text: string) => void | boolean;
  onStartUserNoteAtHunk?: (fileId: string, hunkIndex: number, target?: ReviewNoteTargetV1) => void;
  onViewportLineCursorChange?: (cursor: LineCursor) => void;
  renderedLineCursor: LineCursor | null;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  scrollViewportHeight: number;
  selectionCommentKeyLabel?: string;
  selectionCopyKeyLabel?: string;
}

/**
 * Acquire and retain pointer or keyboard selections over DiffPane's measured review stream.
 *
 * DiffPane supplies every layout, viewport, and cursor fact. This controller only coordinates
 * gestures, selection state, semantic projections, explicit actions, and their presentation plan.
 */
export function useDiffSelectionController({
  cancelCopySelectionRef,
  selectionActionsRef,
  selectionGeometryKey,
  context,
  effectiveScrollTop,
  height,
  lineCursorBoundsOf,
  lineCursors,
  onCopyFeedback,
  onCopySelectionText,
  onStartUserNoteAtHunk,
  onViewportLineCursorChange,
  renderedLineCursor,
  scrollRef,
  scrollViewportHeight,
  selectionCommentKeyLabel,
  selectionCopyKeyLabel,
}: UseDiffSelectionControllerOptions) {
  const renderer = useRenderer();
  const {
    copyDecorations,
    fileSectionLayouts,
    layout,
    pinnedHeaderFile,
    sectionGeometry,
    width: diffContentWidth,
  } = context;
  const pinnedHeaderFileId = pinnedHeaderFile?.id ?? null;
  const [selectionDrag, setSelectionDrag] = useState<CopySelectionDrag | null>(null);
  // Pointer gestures and committed selections are separate: mouse-up retires capture while the
  // committed range remains painted and available to Comment, Copy, and Clear.
  const pointerDragRef = useRef<CopySelectionDrag | null>(null);
  const committedSelectionRef = useRef<CopySelectionDrag | null>(null);
  const keyboardSelectionRef = useRef<{
    anchorTop: number;
    anchorBottom: number;
    side: "old" | "new";
    focus: LineCursor;
  } | null>(null);
  const lastClickTimeRef = useRef(0);
  const clickCountRef = useRef(0);
  const lastClickPointRef = useRef<CopySelectionPoint | null>(null);

  /** Retire pointer and committed selection state together. */
  const clearSelection = useCallback(() => {
    const hadSelection = pointerDragRef.current !== null || committedSelectionRef.current !== null;
    pointerDragRef.current = null;
    committedSelectionRef.current = null;
    keyboardSelectionRef.current = null;
    setSelectionDrag(null);
    return hadSelection;
  }, []);

  const previousSelectionGeometryKeyRef = useRef(selectionGeometryKey);
  useLayoutEffect(() => {
    if (previousSelectionGeometryKeyRef.current !== selectionGeometryKey) {
      clearSelection();
      previousSelectionGeometryKeyRef.current = selectionGeometryKey;
    }
  }, [clearSelection, selectionGeometryKey]);

  // In split layout, selection paint, clipboard copy, and comment projection all retain the side
  // where acquisition began. Stack layout has one column, so its side remains undefined.
  const selectionSide: CopySelectionSide | undefined = useMemo(() => {
    if (!selectionDrag || selectionDrag.anchor.kind !== "review-row") return undefined;
    return resolveCopySelectionSide(selectionDrag.anchor.column, layout, diffContentWidth);
  }, [diffContentWidth, layout, selectionDrag]);

  const selectedRowKeysByFile = useMemo(
    () =>
      buildCopySelectedRowKeys({
        drag: selectionDrag,
        fileSectionLayouts,
        sectionGeometry,
        width: diffContentWidth,
      }),
    [diffContentWidth, fileSectionLayouts, sectionGeometry, selectionDrag],
  );

  /** Copy text through the injected boundary or the renderer's OSC 52 support. */
  const copySelectionText = useCallback(
    (text: string) => {
      if (text.length === 0) return;
      if (onCopySelectionText) {
        onCopySelectionText(text);
        return;
      }
      const supportsOsc52 = renderer.isOsc52Supported?.() ?? false;
      if (supportsOsc52 && typeof renderer.copyToClipboardOSC52 === "function") {
        renderer.copyToClipboardOSC52(text);
        onCopyFeedback?.("Copied selection to clipboard");
        return;
      }
      onCopyFeedback?.(
        "Clipboard copy unsupported in this terminal (enable OSC 52 to capture selections)",
      );
    },
    [onCopyFeedback, onCopySelectionText, renderer],
  );

  /** Project one visual selection through the canonical section geometry. */
  const projectSelectionForComment = useCallback(
    (drag: CopySelectionDrag | null) =>
      projectCommentSelection({
        drag,
        fileSectionLayouts,
        sectionGeometry,
        side:
          drag?.anchor.kind === "review-row"
            ? resolveCopySelectionSide(drag.anchor.column, layout, diffContentWidth)
            : undefined,
      }),
    [diffContentWidth, fileSectionLayouts, layout, sectionGeometry],
  );
  const commentSelection = useMemo(
    () => projectSelectionForComment(selectionDrag),
    [projectSelectionForComment, selectionDrag],
  );

  /** Copy the committed range without coupling acquisition to clipboard support. */
  const copyCommittedSelection = useCallback(() => {
    const selection = committedSelectionRef.current;
    if (!selection) return false;
    const { start, end } = normalizeCopySelectionRange(selection.anchor, selection.focus);
    copySelectionText(
      renderCopySelectionText({
        context,
        end,
        side: resolveCopySelectionSide(selection.anchor.column, layout, diffContentWidth),
        start,
      }),
    );
    return true;
  }, [context, copySelectionText, diffContentWidth, layout]);

  /** Start a range note when the committed selection has one semantic projection. */
  const commentOnCommittedSelection = useCallback(() => {
    const selection = committedSelectionRef.current;
    if (!selection) return false;
    const committedCommentSelection = projectSelectionForComment(selection);
    if (!committedCommentSelection.ok) {
      onCopyFeedback?.(committedCommentSelection.reason);
      return true;
    }
    onStartUserNoteAtHunk?.(
      committedCommentSelection.selection.fileId,
      committedCommentSelection.selection.hunkIndex,
      committedCommentSelection.selection.target,
    );
    clearSelection();
    return true;
  }, [clearSelection, onCopyFeedback, onStartUserNoteAtHunk, projectSelectionForComment]);

  /** Return full-line terminal columns for one source side in the active layout. */
  const keyboardSelectionColumns = useCallback(
    (side: "old" | "new") => {
      if (layout !== "split") return { start: 0, end: Math.max(0, diffContentWidth - 1) };
      const { leftWidth } = resolveSplitPaneWidths(diffContentWidth);
      return side === "old"
        ? { start: 0, end: Math.max(0, leftWidth - 1) }
        : { start: leftWidth, end: Math.max(leftWidth, diffContentWidth - 1) };
    },
    [diffContentWidth, layout],
  );

  /** Commit keyboard geometry synchronously so batched input reads the latest focus. */
  const commitKeyboardSelectionFocus = useCallback(
    (focus: LineCursor) => {
      const keyboardSelection = keyboardSelectionRef.current;
      if (!keyboardSelection || focus.target.side !== keyboardSelection.side) return false;
      const bounds = lineCursorBoundsOf(focus);
      if (!bounds) return false;
      const focusTop = bounds.top;
      const focusBottom = bounds.top + Math.max(0, bounds.height - 1);
      const columns = keyboardSelectionColumns(keyboardSelection.side);
      const movingDown = focusTop >= keyboardSelection.anchorTop;
      const selection: CopySelectionDrag = {
        anchor: {
          kind: "review-row",
          visualRow: movingDown ? keyboardSelection.anchorTop : keyboardSelection.anchorBottom,
          column: movingDown ? columns.start : columns.end,
        },
        focus: {
          kind: "review-row",
          visualRow: movingDown ? focusBottom : focusTop,
          column: movingDown ? columns.end : columns.start,
        },
        moved: true,
        expanded: true,
      };
      keyboardSelection.focus = focus;
      committedSelectionRef.current = selection;
      setSelectionDrag(selection);
      return true;
    },
    [keyboardSelectionColumns, lineCursorBoundsOf],
  );

  /** Begin keyboard acquisition at the current measured source row. */
  const beginKeyboardSelection = useCallback(() => {
    if (!renderedLineCursor) return false;
    const bounds = lineCursorBoundsOf(renderedLineCursor);
    if (!bounds) return false;
    keyboardSelectionRef.current = {
      anchorTop: bounds.top,
      anchorBottom: bounds.top + Math.max(0, bounds.height - 1),
      side: renderedLineCursor.target.side,
      focus: renderedLineCursor,
    };
    pointerDragRef.current = null;
    return commitKeyboardSelectionFocus(renderedLineCursor);
  }, [commitKeyboardSelectionFocus, lineCursorBoundsOf, renderedLineCursor]);

  /** Move keyboard focus through source rows on the anchored side. */
  const moveKeyboardSelection = useCallback(
    (delta: number) => {
      const keyboardSelection = keyboardSelectionRef.current;
      if (!keyboardSelection || !onViewportLineCursorChange) return false;
      const candidates = lineCursors.flatMap((cursor) => {
        if (cursor.target.side === keyboardSelection.side) return [cursor];
        const contextSides = contextLineStableKeySides(cursor.stableKey);
        return keyboardSelection.side === "old" && contextSides
          ? [{ ...cursor, target: { side: "old" as const, line: contextSides.oldLine } }]
          : [];
      });
      const currentIndex = candidates.findIndex(
        (cursor) =>
          cursor.fileId === keyboardSelection.focus.fileId &&
          cursor.stableKey === keyboardSelection.focus.stableKey,
      );
      if (currentIndex < 0) return false;
      const next = candidates[Math.min(candidates.length - 1, Math.max(0, currentIndex + delta))];
      if (!next) return true;
      commitKeyboardSelectionFocus(next);
      onViewportLineCursorChange(next);
      return true;
    },
    [commitKeyboardSelectionFocus, lineCursors, onViewportLineCursorChange],
  );

  useEffect(() => {
    if (keyboardSelectionRef.current && renderedLineCursor) {
      commitKeyboardSelectionFocus(renderedLineCursor);
    }
  }, [commitKeyboardSelectionFocus, renderedLineCursor]);

  /** Resolve a terminal event against the supplied review viewport and section geometry. */
  const resolveSelectionPoint = useCallback(
    (event: TuiMouseEvent): CopySelectionPoint | null => {
      const scrollBox = scrollRef.current;
      if (!scrollBox) return null;
      const viewportScreenX = scrollBox.viewport.screenX;
      const viewportScreenY = scrollBox.viewport.screenY;
      const contentScreenY = scrollBox.content.screenY;
      const column = Math.floor(event.x - viewportScreenX);
      if (copyDecorations && pinnedHeaderFileId && Math.floor(event.y) === viewportScreenY - 1) {
        return {
          kind: "pinned-header",
          column: clampCopyColumn(column, diffContentWidth),
          fileId: pinnedHeaderFileId,
          nextVisualRow: Math.floor(viewportScreenY - contentScreenY),
        };
      }
      const viewportY = Math.floor(event.y - viewportScreenY);
      if (viewportY < 0 || viewportY >= Math.max(1, scrollBox.viewport.height ?? 0)) return null;
      return findCopySelectionPoint({
        column,
        copyDecorations,
        fileSectionLayouts,
        sectionGeometry,
        visualRow: Math.floor(event.y - contentScreenY),
        width: diffContentWidth,
      });
    },
    [
      copyDecorations,
      diffContentWidth,
      fileSectionLayouts,
      pinnedHeaderFileId,
      scrollRef,
      sectionGeometry,
    ],
  );

  /** Suppress OpenTUI's cross-renderable native selection while Hunk owns a drag. */
  const suppressNativeSelection = useCallback(() => {
    if (renderer.hasSelection) renderer.clearSelection();
  }, [renderer]);

  /** Start selecting diff text from a left-button event in the review stream. */
  const beginSelection = useCallback(
    (event: TuiMouseEvent) => {
      if (event.button !== MouseButton.LEFT) return;
      const point = resolveSelectionPoint(event);
      if (!point) {
        clearSelection();
        clickCountRef.current = 0;
        lastClickPointRef.current = null;
        return;
      }
      committedSelectionRef.current = null;
      keyboardSelectionRef.current = null;
      const now = Date.now();
      const timeSinceLastClick = now - lastClickTimeRef.current;
      const previousClickPoint = lastClickPointRef.current;
      const repeatedClickTarget =
        previousClickPoint !== null &&
        copySelectionPointsShareRow(previousClickPoint, point) &&
        Math.abs(previousClickPoint.column - point.column) <= 2;
      lastClickTimeRef.current = now;
      lastClickPointRef.current = point;
      let clickCount = 1;
      if (timeSinceLastClick < 350 && timeSinceLastClick >= 0 && repeatedClickTarget) {
        clickCountRef.current += 1;
        clickCount = Math.min(clickCountRef.current, 3);
      } else {
        clickCountRef.current = 1;
      }
      if (clickCount >= 2 && point.kind === "review-row") {
        const expanded = expandSelectionPoint(point, clickCount as 2 | 3, context);
        if (expanded) {
          const drag: CopySelectionDrag = {
            anchor: { ...point, column: expanded.startCol },
            focus: { ...point, column: expanded.endCol },
            moved: true,
            expanded: true,
          };
          pointerDragRef.current = drag;
          setSelectionDrag(drag);
          suppressNativeSelection();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      const initial: CopySelectionDrag = { anchor: point, focus: point, moved: false };
      pointerDragRef.current = initial;
      setSelectionDrag(initial);
      suppressNativeSelection();
      event.preventDefault();
      event.stopPropagation();
    },
    [clearSelection, context, resolveSelectionPoint, suppressNativeSelection],
  );

  /** Extend the active selection and synchronously retain coalesced terminal motion. */
  const updateSelection = useCallback(
    (event: TuiMouseEvent) => {
      setSelectionDrag((current) => {
        if (!current) return current;
        const point = resolveSelectionPoint(event);
        if (!point) return current;
        return {
          anchor: current.anchor,
          focus: point,
          moved: current.moved || !copySelectionPointsEqual(point, current.anchor),
          expanded: current.expanded,
        };
      });
      const pending = pointerDragRef.current;
      if (pending) {
        const point = resolveSelectionPoint(event);
        if (point) {
          pointerDragRef.current = {
            anchor: pending.anchor,
            focus: point,
            moved: pending.moved || !copySelectionPointsEqual(point, pending.anchor),
            expanded: pending.expanded,
          };
        }
      }
      if (pointerDragRef.current) {
        const scrollBox = scrollRef.current;
        if (scrollBox) setMouseCapture(renderer, scrollBox);
        suppressNativeSelection();
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [renderer, resolveSelectionPoint, scrollRef, suppressNativeSelection],
  );

  /** Finish a pointer gesture, preserving click navigation and committing deliberate ranges. */
  const endSelection = useCallback(
    (event?: TuiMouseEvent) => {
      const pending = pointerDragRef.current;
      if (!pending) return;
      const endPoint = event && !pending.expanded ? resolveSelectionPoint(event) : null;
      const current = endPoint
        ? {
            anchor: pending.anchor,
            focus: endPoint,
            moved: pending.moved || !copySelectionPointsEqual(endPoint, pending.anchor),
            expanded: pending.expanded,
          }
        : pending;
      pointerDragRef.current = null;
      event?.preventDefault();
      event?.stopPropagation();
      if (copySelectionDragIsClick(current)) {
        committedSelectionRef.current = null;
        setSelectionDrag(null);
        if (event && isNestedRowMouseAction(event)) return;
        const clickedCursor = findLineCursorForClick({
          cursors: lineCursors,
          fileSectionLayouts,
          point: current.anchor,
          sectionGeometry,
          side: resolveCopySelectionSide(current.anchor.column, layout, diffContentWidth),
        });
        if (clickedCursor && onViewportLineCursorChange) {
          onViewportLineCursorChange(clickedCursor);
          return;
        }
        if (!current.moved) return;
      }
      // Mouse-up only commits; Copy and Comment remain explicit actions.
      committedSelectionRef.current = current;
      setSelectionDrag(current);
    },
    [
      diffContentWidth,
      fileSectionLayouts,
      layout,
      lineCursors,
      onViewportLineCursorChange,
      resolveSelectionPoint,
      sectionGeometry,
    ],
  );

  // Let App release a stuck gesture after mouse-up outside the review pane.
  useLayoutEffect(() => {
    if (!cancelCopySelectionRef) return;
    cancelCopySelectionRef.current = () => {
      if (pointerDragRef.current) endSelection();
    };
    return () => {
      cancelCopySelectionRef.current = null;
    };
  }, [cancelCopySelectionRef, endSelection]);

  useLayoutEffect(() => {
    if (!selectionActionsRef) return;
    selectionActionsRef.current = {
      hasSelection: () => committedSelectionRef.current !== null,
      beginKeyboardSelection,
      copy: copyCommittedSelection,
      comment: commentOnCommittedSelection,
      clear: clearSelection,
      move: moveKeyboardSelection,
    };
    return () => {
      selectionActionsRef.current = null;
    };
  }, [
    beginKeyboardSelection,
    clearSelection,
    commentOnCommittedSelection,
    copyCommittedSelection,
    moveKeyboardSelection,
    selectionActionsRef,
  ]);

  const commentLabel = `${selectionCommentKeyLabel ? `${selectionCommentKeyLabel} ` : ""}Comment`;
  const copyLabel = `${selectionCopyKeyLabel ? `${selectionCopyKeyLabel} ` : ""}Copy`;
  // Two spaces surround each dynamic label, ` Esc Clear ` occupies eleven cells, and the border
  // occupies two more when all actions fit on one row.
  const preferredActionBarWidth = Math.max(
    SELECTION_ACTION_BAR_WIDTH,
    commentLabel.length + copyLabel.length + 17,
  );
  const actionBarModel = useMemo<SelectionActionBarViewModel | null>(() => {
    if (!selectionDrag || committedSelectionRef.current === null) return null;
    const focusVisualRow =
      selectionDrag.focus.kind === "review-row"
        ? selectionDrag.focus.visualRow
        : selectionDrag.focus.nextVisualRow - 1;
    const splitWidths = layout === "split" ? resolveSplitPaneWidths(diffContentWidth) : null;
    const selectedPaneLeft = splitWidths && selectionSide === "right" ? splitWidths.leftWidth : 0;
    const selectedPaneWidth = splitWidths
      ? selectionSide === "right"
        ? splitWidths.rightWidth
        : splitWidths.leftWidth
      : diffContentWidth;
    const bounds = planSelectionActionBar({
      focusVisualRow,
      scrollTop: effectiveScrollTop,
      viewportHeight:
        scrollViewportHeight ||
        scrollRef.current?.viewport.height ||
        Math.max(0, (height ?? 0) - 1),
      paneWidth: selectedPaneWidth,
      preferredWidth: preferredActionBarWidth,
      reason: commentSelection.ok ? undefined : commentSelection.reason,
    });
    return bounds
      ? {
          bounds: { ...bounds, left: bounds.left + selectedPaneLeft },
          commentEnabled: commentSelection.ok,
          commentLabel,
          copyLabel,
        }
      : null;
  }, [
    commentLabel,
    commentSelection,
    copyLabel,
    diffContentWidth,
    effectiveScrollTop,
    height,
    layout,
    preferredActionBarWidth,
    scrollRef,
    scrollViewportHeight,
    selectionDrag,
    selectionSide,
  ]);

  return {
    actionBarModel,
    beginSelection,
    clearSelection,
    commentOnCommittedSelection,
    copyCommittedSelection,
    endSelection,
    selectedRowKeysByFile,
    selectionSide,
    suppressNativeSelection,
    updateSelection,
  };
}
