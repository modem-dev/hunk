/** @jsxImportSource react */
/**
 * Mounts one file's Pierre diff and the page's own gap separators inside it.
 *
 * Pierre's React wrapper cannot host custom hunk separators, and the page needs them: a
 * collapsed gap must expand through the page's store (`expansion/toggle`), not through
 * Pierre's own expansion, so the terminal and the browser agree on what a gap is. So this
 * component drives Pierre's vanilla `FileDiff` and supplies separators as DOM nodes it owns,
 * updating their text in place when a gap starts loading or fails — Pierre only re-creates a
 * separator when its geometry changes.
 *
 * Highlight options are the terminal's (`ui/diff/highlightRenderOptions.ts`): word-level
 * `word-alt` emphasis and the same tokenizing bound.
 */
import { FileDiff, type FileDiffOptions, type HunkData } from "@pierre/diffs";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { pierreHighlightRenderOptions } from "../../ui/diff/highlightRenderOptions";
import {
  reviewGapIdForSeparator,
  type ReviewFileRenderPlan,
  type ReviewGapView,
} from "./fileProjection";
import {
  measureReviewFileGeometry,
  reviewHunkAtRow,
  rowIndexOf,
  type ReviewFileGeometry,
} from "./hunkGeometry";

export interface PierreFileViewProps {
  plan: ReviewFileRenderPlan;
  layout: "split" | "unified";
  wrapLines: boolean;
  showLineNumbers: boolean;
  syntaxTheme: string;
  appearance: "light" | "dark";
  onToggleGap: (gapId: string) => void;
  /** The selected hunk when this file holds the selection; it gets the accent rail. */
  selectedHunk?: number;
  /** A click on one hunk's rows. */
  onSelectHunk: (hunkIndex: number) => void;
  /** Where this file's hunks and expanded gaps were drawn, after every render or resize. */
  onGeometry: (geometry: ReviewFileGeometry) => void;
}

/** The words one gap separator shows for its state. */
export function gapSeparatorText(gap: ReviewGapView) {
  const count = gap.address.lineCount;
  const lines = `${count} unchanged ${count === 1 ? "line" : "lines"}`;
  switch (gap.state) {
    case "loading":
      return `Loading ${lines}…`;
    case "error":
      return `Could not load ${lines}`;
    case "too-large":
      return `Source too large to expand ${lines}`;
    default:
      return lines;
  }
}

/** The words an expanded gap's collapse control shows, as the terminal's row says them. */
export function expandedGapText(gap: ReviewGapView) {
  const count = gap.address.lineCount;
  return `Hide ${count} unchanged ${count === 1 ? "line" : "lines"}`;
}

/**
 * Fill one separator element for the gap it stands for, or as inert context.
 *
 * The terminal's `▾` (expandable) and `···` (inert) marks are drawn by CSS from
 * `data-gap-state`, so the accessible name stays the words alone.
 */
function paintSeparator(element: HTMLButtonElement, gap: ReviewGapView | undefined) {
  element.dataset.gapState = gap?.state ?? "unaddressed";
  element.disabled = !gap || gap.state === "loading";
  element.textContent = gap ? gapSeparatorText(gap) : "Unchanged lines";
  element.title = gap && gap.state === "collapsed" ? "Show unchanged lines" : "";
}

/** Render one file through Pierre. */
export function PierreFileView({
  plan,
  layout,
  wrapLines,
  showLineNumbers,
  syntaxTheme,
  appearance,
  onToggleGap,
  selectedHunk,
  onSelectHunk,
  onGeometry,
}: PierreFileViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<FileDiff | null>(null);
  const separatorsRef = useRef(new Map<string, Set<HTMLButtonElement>>());
  const planRef = useRef(plan);
  const toggleRef = useRef(onToggleGap);
  planRef.current = plan;
  toggleRef.current = onToggleGap;
  const [geometry, setGeometry] = useState<ReviewFileGeometry | undefined>(undefined);
  const geometryRef = useRef(onGeometry);
  geometryRef.current = onGeometry;

  // Re-measure after Pierre draws and whenever the drawing changes size (wrapping, fonts).
  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const current = planRef.current;
    const next = measureReviewFileGeometry(host, current.file, current.gaps, layout);
    setGeometry(next);
    geometryRef.current(next);
  }, [layout]);

  const options: FileDiffOptions<undefined, undefined> = {
    ...pierreHighlightRenderOptions(syntaxTheme),
    themeType: appearance,
    diffStyle: layout,
    overflow: wrapLines ? "wrap" : "scroll",
    disableLineNumbers: !showLineNumbers,
    disableFileHeader: true,
    // Every gap the shared model addresses stays collapsed until the store expands it.
    collapsedContextThreshold: 0,
    hunkSeparators: (hunk: HunkData) => {
      const gapId = reviewGapIdForSeparator(planRef.current.file, hunk.hunkIndex);
      const element = document.createElement("button");
      element.type = "button";
      element.className = "gap-separator";
      element.dataset.gapId = gapId;
      element.addEventListener("click", () => toggleRef.current(gapId));
      paintSeparator(
        element,
        planRef.current.gaps.find((gap) => gap.gapId === gapId),
      );
      const group = separatorsRef.current.get(gapId) ?? new Set();
      group.add(element);
      separatorsRef.current.set(gapId, group);
      return element;
    },
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !plan.metadata) return;
    let instance = instanceRef.current;
    if (!instance) {
      instance = new FileDiff(options);
      instanceRef.current = instance;
      instance.render({ fileDiff: plan.metadata, containerWrapper: host });
    } else {
      instance.setOptions(options);
      instance.render({ fileDiff: plan.metadata, forceRender: true });
    }
    // Separators Pierre kept across this render still show the old state; repaint them.
    for (const [gapId, elements] of separatorsRef.current) {
      for (const element of elements) {
        if (!element.isConnected) {
          elements.delete(element);
          continue;
        }
        paintSeparator(
          element,
          plan.gaps.find((gap) => gap.gapId === gapId),
        );
      }
    }
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
    // `options` is rebuilt from exactly these inputs, so they are the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, layout, wrapLines, showLineNumbers, syntaxTheme, appearance]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(host);
    return () => observer.disconnect();
  }, [measure]);

  // A click on a hunk's rows selects that hunk without moving the viewport; `[` and `]` are
  // the keyboard path to the same selection. A drag that selected text is the reader copying.
  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (window.getSelection()?.isCollapsed === false) return;
      for (const target of event.nativeEvent.composedPath()) {
        if (!(target instanceof Element)) continue;
        if (target.tagName === "BUTTON") return;
        const row = target.hasAttribute("data-line-index") ? rowIndexOf(target, layout) : undefined;
        if (row === undefined) continue;
        const hunk = reviewHunkAtRow(planRef.current.file, layout, row);
        if (hunk !== undefined) onSelectHunk(hunk);
        return;
      }
    },
    [layout, onSelectHunk],
  );

  useEffect(
    () => () => {
      instanceRef.current?.cleanUp();
      instanceRef.current = null;
    },
    [],
  );

  const rail = selectedHunk === undefined ? undefined : geometry?.hunks[selectedHunk];
  return (
    <div className="pierre-frame">
      <div className="pierre-host" ref={hostRef} onClick={onClick} />
      {rail ? (
        <div
          className="hunk-rail"
          data-testid="selected-hunk"
          data-hunk-index={selectedHunk}
          style={{ top: rail.top, height: rail.height }}
          aria-hidden="true"
        />
      ) : null}
      {plan.gaps
        .filter((gap) => gap.state === "expanded")
        .map((gap) => {
          const bounds = geometry?.gaps.get(gap.gapId);
          return bounds ? (
            <button
              key={gap.gapId}
              type="button"
              className="gap-collapse"
              data-gap-id={gap.gapId}
              style={{ top: bounds.top }}
              onClick={() => onToggleGap(gap.gapId)}
            >
              {expandedGapText(gap)}
            </button>
          ) : null;
        })}
    </div>
  );
}
