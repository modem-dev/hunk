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
 *
 * Line annotations carry each line's note cards and open composers: cards are plain DOM, and
 * each composer is a React portal into a slot its annotation provides. Pierre's gutter utility
 * (the hover affordance) and its line selection report the line or range the reader picked;
 * card buttons report the note action they name.
 */
import {
  FileDiff,
  type DiffLineAnnotation,
  type FileDiffOptions,
  type HunkData,
  type SelectedLineRange,
} from "@pierre/diffs";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReviewSide } from "../../core/review/types";
import { pierreHighlightRenderOptions } from "../../ui/diff/highlightRenderOptions";
import {
  reviewGapIdForSeparator,
  type ReviewFileRenderPlan,
  type ReviewGapView,
} from "./fileProjection";
import type { ReviewAgentHighlightV1 } from "../../session/reviewSharedState";
import type { NoteComposer } from "../notes/composerStore";
import { renderNoteGroup, type WebNoteCardAction } from "../notes/noteCards";
import type { WebNoteGroup } from "../notes/noteProjection";
import { measureAgentHighlights, type ReviewHighlightBox } from "./highlightGeometry";
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
  /** Note cards per anchor line, drawn in the diff flow through Pierre's line annotations. */
  noteGroups: readonly WebNoteGroup[];
  /** Agent attention marks on this file's lines. */
  highlights: readonly ReviewAgentHighlightV1[];
  /** This file's open composers. */
  composers: readonly NoteComposer[];
  /** Draw one composer into its slot. */
  renderComposer: (composer: NoteComposer) => ReactNode;
  /** The reader picked one line, or a range on one side, to write a note about. */
  onPickLines: (side: ReviewSide, start: number, end: number) => void;
  /** A card's action button, or a click on the card itself (`select`). */
  onNoteAction: (action: WebNoteCardAction | "select", noteId: string) => void;
}

/** What one line annotation carries: the line's note cards and its composers. */
interface WebLineAnnotation {
  key: string;
  group?: WebNoteGroup;
  composerKeys: readonly string[];
}

/** Pierre's side name for one shared-model side, and back. */
function pierreSide(side: ReviewSide) {
  return side === "new" ? ("additions" as const) : ("deletions" as const);
}

/** The shared-model side Pierre's selection names. */
function modelSide(side: SelectedLineRange["side"]): ReviewSide {
  return side === "deletions" ? "old" : "new";
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
  noteGroups,
  highlights,
  composers,
  renderComposer,
  onPickLines,
  onNoteAction,
}: PierreFileViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<FileDiff<WebLineAnnotation> | null>(null);
  const pickRef = useRef(onPickLines);
  pickRef.current = onPickLines;
  // Composer slots Pierre's annotations provide, by annotation key.
  const slotsRef = useRef(new Map<string, HTMLElement>());
  const [, setSlotVersion] = useState(0);

  // One annotation per line, carrying its cards and composers. Rebuilt only when cards or
  // composer positions change, so typing in a composer never redraws the diff.
  const composerSignature = composers
    .map((composer) => `${composer.key}@${composer.side}:${composer.line}`)
    .join("|");
  const annotations = useMemo(() => {
    const byLine = new Map<string, DiffLineAnnotation<WebLineAnnotation>>();
    const entry = (side: ReviewSide, line: number) => {
      const key = `${side}:${line}`;
      let annotation = byLine.get(key);
      if (!annotation) {
        annotation = {
          side: pierreSide(side),
          lineNumber: line,
          metadata: { key, composerKeys: [] },
        };
        byLine.set(key, annotation);
      }
      return annotation;
    };
    for (const group of noteGroups) {
      const annotation = entry(group.side, group.line);
      annotation.metadata = { ...annotation.metadata, group };
    }
    for (const composer of composers) {
      const annotation = entry(composer.side, composer.line);
      annotation.metadata = {
        ...annotation.metadata,
        composerKeys: [...annotation.metadata.composerKeys, composer.key],
      };
    }
    return [...byLine.values()];
    // The signature stands for the composers' positions; their text is read at render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteGroups, composerSignature]);
  const separatorsRef = useRef(new Map<string, Set<HTMLButtonElement>>());
  const planRef = useRef(plan);
  const toggleRef = useRef(onToggleGap);
  planRef.current = plan;
  toggleRef.current = onToggleGap;
  const [geometry, setGeometry] = useState<ReviewFileGeometry | undefined>(undefined);
  const geometryRef = useRef(onGeometry);
  geometryRef.current = onGeometry;
  const [highlightBoxes, setHighlightBoxes] = useState<ReviewHighlightBox[]>([]);
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;

  // Re-measure after Pierre draws and whenever the drawing changes size (wrapping, fonts).
  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const current = planRef.current;
    const next = measureReviewFileGeometry(host, current.file, current.gaps, layout);
    setGeometry(next);
    setHighlightBoxes(measureAgentHighlights(host, highlightsRef.current, layout));
    geometryRef.current(next);
  }, [layout]);

  const options: FileDiffOptions<WebLineAnnotation, undefined> = {
    ...pierreHighlightRenderOptions(syntaxTheme),
    themeType: appearance,
    diffStyle: layout,
    overflow: wrapLines ? "wrap" : "scroll",
    disableLineNumbers: !showLineNumbers,
    disableFileHeader: true,
    // Every gap the shared model addresses stays collapsed until the store expands it.
    collapsedContextThreshold: 0,
    renderAnnotation: (annotation: DiffLineAnnotation<WebLineAnnotation>) => {
      const root = document.createElement("div");
      root.className = "line-annotation";
      const { group, composerKeys, key } = annotation.metadata;
      if (group) root.append(renderNoteGroup(group));
      if (composerKeys.length > 0) {
        const slot = document.createElement("div");
        slot.className = "composer-slot";
        slotsRef.current.set(key, slot);
        root.append(slot);
        // Portals follow the slot Pierre just placed.
        queueMicrotask(() => setSlotVersion((version) => version + 1));
      }
      return root;
    },
    // Hovering a line offers a gutter button; dragging line numbers selects a range.
    enableGutterUtility: true,
    onGutterUtilityClick: (range: SelectedLineRange) => {
      const side = modelSide(range.side);
      pickRef.current(
        side,
        range.start,
        range.side === range.endSide || !range.endSide ? range.end : range.start,
      );
    },
    enableLineSelection: true,
    onLineSelectionEnd: (range: SelectedLineRange | null) => {
      if (!range) return;
      const side = modelSide(range.side);
      // A range spans one side; one that crossed sides keeps the side it started on.
      const end = range.endSide && range.endSide !== range.side ? range.start : range.end;
      pickRef.current(side, range.start, end);
      instanceRef.current?.setSelectedLines(null);
    },
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
    const lineAnnotations = annotations;
    let instance = instanceRef.current;
    if (!instance) {
      instance = new FileDiff<WebLineAnnotation>(options);
      instanceRef.current = instance;
      instance.render({ fileDiff: plan.metadata, containerWrapper: host, lineAnnotations });
    } else {
      instance.setOptions(options);
      instance.render({ fileDiff: plan.metadata, forceRender: true, lineAnnotations });
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
  }, [plan, layout, wrapLines, showLineNumbers, syntaxTheme, appearance, annotations]);

  // Sideways code scrolling moves the characters under the agent marks.
  useEffect(() => {
    const root = hostRef.current?.querySelector("diffs-container")?.shadowRoot;
    if (!root) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setHighlightBoxes(
          hostRef.current
            ? measureAgentHighlights(hostRef.current, highlightsRef.current, layout)
            : [],
        ),
      );
    };
    root.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [plan, layout]);

  // New marks need no new drawing, only new boxes over the lines already drawn.
  useEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [highlights, measure]);

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
      const path = event.nativeEvent.composedPath();
      for (const target of path) {
        if (!(target instanceof Element)) continue;
        const action = target.getAttribute("data-note-action") as WebNoteCardAction | null;
        const card = target.closest("[data-note-id]");
        if (action && card) {
          onNoteAction(action, card.getAttribute("data-note-id")!);
          return;
        }
        if (target.closest(".note-composer")) return;
        if (target.classList.contains("note-card")) {
          onNoteAction("select", target.getAttribute("data-note-id")!);
          return;
        }
      }
      if (window.getSelection()?.isCollapsed === false) return;
      for (const target of path) {
        if (!(target instanceof Element)) continue;
        if (target.tagName === "BUTTON") return;
        const row = target.hasAttribute("data-line-index") ? rowIndexOf(target, layout) : undefined;
        if (row === undefined) continue;
        const hunk = reviewHunkAtRow(planRef.current.file, layout, row);
        if (hunk !== undefined) onSelectHunk(hunk);
        return;
      }
    },
    [layout, onSelectHunk, onNoteAction],
  );

  useEffect(
    () => () => {
      instanceRef.current?.cleanUp();
      instanceRef.current = null;
    },
    [],
  );

  // Composers render into the annotation slots Pierre mounted, one small React root per slot:
  // the slots live in Pierre's DOM, outside this component's tree. A slot whose composers all
  // closed, or that Pierre dropped, has its root unmounted after this commit.
  const composerRootsRef = useRef(new Map<HTMLElement, Root>());
  useLayoutEffect(() => {
    const roots = composerRootsRef.current;
    const live = new Set<HTMLElement>();
    for (const annotation of annotations) {
      const slot = slotsRef.current.get(annotation.metadata.key);
      if (!slot?.isConnected || annotation.metadata.composerKeys.length === 0) continue;
      const shown = annotation.metadata.composerKeys.flatMap((key) => {
        const composer = composers.find((candidate) => candidate.key === key);
        return composer ? [<div key={key}>{renderComposer(composer)}</div>] : [];
      });
      live.add(slot);
      let root = roots.get(slot);
      if (!root) {
        root = createRoot(slot);
        roots.set(slot, root);
      }
      root.render(<div className="composer-stack">{shown}</div>);
    }
    for (const [slot, root] of roots) {
      if (live.has(slot)) continue;
      roots.delete(slot);
      // A root cannot unmount synchronously while this one commits.
      queueMicrotask(() => root.unmount());
    }
  });
  useEffect(
    () => () => {
      const roots = Array.from(composerRootsRef.current.values());
      composerRootsRef.current.clear();
      queueMicrotask(() => {
        for (const root of roots) root.unmount();
      });
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
      {highlightBoxes.map((box, index) => (
        <div
          key={index}
          className="agent-highlight"
          data-tone={box.tone}
          data-side={box.side}
          data-line={box.line}
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
          aria-hidden="true"
        />
      ))}
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
