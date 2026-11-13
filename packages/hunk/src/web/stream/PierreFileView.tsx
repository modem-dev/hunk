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
import { useEffect, useRef } from "react";
import { pierreHighlightRenderOptions } from "../../ui/diff/highlightRenderOptions";
import {
  reviewGapIdForSeparator,
  type ReviewFileRenderPlan,
  type ReviewGapView,
} from "./fileProjection";

export interface PierreFileViewProps {
  plan: ReviewFileRenderPlan;
  layout: "split" | "unified";
  wrapLines: boolean;
  showLineNumbers: boolean;
  syntaxTheme: string;
  appearance: "light" | "dark";
  onToggleGap: (gapId: string) => void;
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

/** Fill one separator element for the gap it stands for, or as inert context. */
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
}: PierreFileViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<FileDiff | null>(null);
  const separatorsRef = useRef(new Map<string, Set<HTMLButtonElement>>());
  const planRef = useRef(plan);
  const toggleRef = useRef(onToggleGap);
  planRef.current = plan;
  toggleRef.current = onToggleGap;

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
    // `options` is rebuilt from exactly these inputs, so they are the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, layout, wrapLines, showLineNumbers, syntaxTheme, appearance]);

  useEffect(
    () => () => {
      instanceRef.current?.cleanUp();
      instanceRef.current = null;
    },
    [],
  );

  return <div className="pierre-host" ref={hostRef} />;
}
