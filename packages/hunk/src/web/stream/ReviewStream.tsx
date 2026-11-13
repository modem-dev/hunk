/** @jsxImportSource react */
/**
 * The review stream: every file of the review, top to bottom, in review order.
 *
 * Selecting a file in the sidebar scrolls this stream to it; it never narrows the stream to
 * one file. Files mount Pierre only as they approach the viewport and unmount when they are
 * far away, and every unmounted file keeps the height it was last measured at (or the
 * height its row count reserves), so the scrollbar stays stable and a 2,000-file review stays
 * responsive. Scrolling reports the file at the top back to the store as a viewport anchor,
 * which moves the sidebar highlight without moving anything else.
 *
 * A reload swaps the document under the reader; the stream keeps the file at the top of the
 * viewport, and the reader's offset inside it, where they were.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReviewState } from "../../core/review/state";
import type { ReviewFileV1 } from "../../core/review/types";
import type { ReviewMirrorFileSlot } from "../mirror/reviewMirror";
import { FileSection } from "./FileSection";
import { planReviewFileRender, type ReviewFileRenderPlan } from "./fileProjection";

/** How far beyond the viewport files mount, and how far before they unmount. */
const MOUNT_MARGIN = "150% 0px 150% 0px";

/** How long a reload keeps re-applying the reader's place while files settle. */
const PIN_AFTER_SWAP_MS = 800;

export interface ReviewStreamProps {
  slots: readonly ReviewMirrorFileSlot[];
  review: ReviewState;
  layout: "split" | "unified";
  wrapLines: boolean;
  showLineNumbers: boolean;
  syntaxTheme: string;
  appearance: "light" | "dark";
  onToggleGap: (fileKey: string, gapId: string) => void;
  onCollapseGaps: (fileKey: string) => void;
  /** The generation shown; a change is a reload that keeps the reader's place. */
  generation?: string;
  /** The file at the top of the viewport changed because the reader scrolled. */
  onTopFileChange: (fileKey: string) => void;
}

/** Plans one file per document state, reusing the previous plan when nothing it reads moved. */
function usePlans(review: ReviewState) {
  const cache = useRef(
    new WeakMap<ReviewFileV1, { gaps: string; status: unknown; plan: ReviewFileRenderPlan }>(),
  );
  return useCallback(
    (file: ReviewFileV1) => {
      const gaps = review.expandedGaps
        .filter((gap) => gap.fileKey === file.key)
        .map((gap) => `${gap.gapId}:${gap.expanded}`)
        .join();
      const status = review.sourceStatusByFileKey[file.key];
      const cached = cache.current.get(file);
      if (cached && cached.gaps === gaps && cached.status === status) return cached.plan;
      const plan = planReviewFileRender(file, review);
      cache.current.set(file, { gaps, status, plan });
      return plan;
    },
    [review],
  );
}

/** The scrollable stream of file sections. */
export function ReviewStream(props: ReviewStreamProps) {
  const { slots, review } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState<ReadonlySet<string>>(new Set());
  const heights = useRef(new Map<string, number>());
  const planOf = usePlans(review);
  const filesByKey = useMemo(
    () => new Map(review.document.files.map((file) => [file.key, file])),
    [review.document],
  );

  // Mount files near the viewport; unmount them once they are well outside it.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setMounted((current) => {
          let next: Set<string> | undefined;
          for (const entry of entries) {
            const key = (entry.target as HTMLElement).dataset.fileKey;
            if (!key) continue;
            if (entry.isIntersecting && !current.has(key)) {
              next ??= new Set(current);
              next.add(key);
            } else if (!entry.isIntersecting && current.has(key)) {
              const body = entry.target.querySelector(".file-body");
              if (body) heights.current.set(key, body.getBoundingClientRect().height);
              next ??= new Set(current);
              next.delete(key);
            }
          }
          return next ?? current;
        });
      },
      { root, rootMargin: MOUNT_MARGIN },
    );
    for (const section of Array.from(
      root.querySelectorAll<HTMLElement>("section[data-file-key]"),
    )) {
      observer.observe(section);
    }
    return () => observer.disconnect();
  }, [slots]);

  // Reveal the selected file's top whenever the store asks for it.
  const revealToken = review.reveal.fileTopToken;
  const selectedKey = review.selection.fileKey;
  useEffect(() => {
    if (revealToken === 0 || !selectedKey) return;
    const section = scrollRef.current?.querySelector<HTMLElement>(
      `section[data-file-key="${CSS.escape(selectedKey)}"]`,
    );
    if (section && scrollRef.current) {
      // An explicit jump wins over keeping the reader's place across a reload.
      releasePin.current?.();
      scrollRef.current.scrollTop = section.offsetTop;
    }
    // Only a new reveal request scrolls; a selection made by scrolling must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken]);

  // Keep the reader's place by file across a document swap.
  const anchor = useRef<{ key: string; offset: number } | undefined>(undefined);
  const releasePin = useRef<(() => void) | undefined>(undefined);
  const topFile = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return undefined;
    // Sections are laid out in order, so the first one ending below the scroll offset is
    // found by bisection rather than a walk over every file.
    const sections = root.querySelectorAll<HTMLElement>("section[data-file-key]");
    let low = 0;
    let high = sections.length - 1;
    let found: HTMLElement | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const section = sections[middle]!;
      if (section.offsetTop + section.offsetHeight > root.scrollTop) {
        found = section;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    return found
      ? { key: found.dataset.fileKey!, offset: root.scrollTop - found.offsetTop }
      : undefined;
  }, []);
  // Only a new generation swaps content under the reader; a first load growing file by file
  // fills space its index already reserved.
  const generationRef = useRef(props.generation);
  if (generationRef.current !== props.generation) {
    if (generationRef.current !== undefined) anchor.current = topFile();
    generationRef.current = props.generation;
  }
  useLayoutEffect(() => {
    const saved = anchor.current;
    anchor.current = undefined;
    const root = scrollRef.current;
    if (!saved || !root) return;
    // Mounted files re-render and re-highlight after this commit and can change height above
    // the anchor, so the anchor is re-applied each frame for a moment — until the reader
    // takes over by scrolling themselves.
    const pin = () => {
      const section = root.querySelector<HTMLElement>(
        `section[data-file-key="${CSS.escape(saved.key)}"]`,
      );
      if (section) root.scrollTop = section.offsetTop + saved.offset;
    };
    let frame = 0;
    const deadline = performance.now() + PIN_AFTER_SWAP_MS;
    const step = () => {
      pin();
      if (performance.now() < deadline) frame = requestAnimationFrame(step);
    };
    const release = () => cancelAnimationFrame(frame);
    releasePin.current = release;
    pin();
    frame = requestAnimationFrame(step);
    root.addEventListener("wheel", release, { once: true, passive: true });
    root.addEventListener("pointerdown", release, { once: true });
    root.addEventListener("keydown", release, { once: true });
    return () => {
      release();
      root.removeEventListener("wheel", release);
      root.removeEventListener("pointerdown", release);
      root.removeEventListener("keydown", release);
    };
  }, [review.document]);

  // Report the file at the top of the viewport as the reader scrolls.
  const lastTop = useRef<string | undefined>(undefined);
  const onScroll = useCallback(() => {
    const top = topFile();
    if (top && top.key !== lastTop.current) {
      lastTop.current = top.key;
      props.onTopFileChange(top.key);
    }
  }, [props, topFile]);

  // Record mounted bodies' real heights so they keep them when they unmount.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const key = (entry.target.parentElement as HTMLElement | null)?.dataset.fileKey;
        if (key && entry.contentRect.height > 0) heights.current.set(key, entry.contentRect.height);
      }
    });
    for (const key of mounted) {
      const body = root.querySelector(`section[data-file-key="${CSS.escape(key)}"] .file-body`);
      if (body) observer.observe(body);
    }
    return () => observer.disconnect();
  }, [mounted, slots]);

  // A layout change reflows every file, so earlier measurements no longer hold.
  useEffect(() => {
    heights.current.clear();
  }, [props.layout, props.wrapLines]);

  return (
    <div className="review-stream" ref={scrollRef} onScroll={onScroll} data-testid="review-stream">
      {slots.map((slot) => {
        const file = filesByKey.get(slot.key);
        return (
          <FileSection
            key={slot.key}
            fileKey={slot.key}
            index={slot.index}
            plan={file ? planOf(file) : undefined}
            mounted={mounted.has(slot.key)}
            measuredHeight={heights.current.get(slot.key)}
            selected={slot.key === selectedKey}
            layout={props.layout}
            wrapLines={props.wrapLines}
            showLineNumbers={props.showLineNumbers}
            syntaxTheme={props.syntaxTheme}
            appearance={props.appearance}
            onToggleGap={props.onToggleGap}
            onCollapseGaps={props.onCollapseGaps}
          />
        );
      })}
      {slots.length === 0 ? <p className="stream-empty">No files in this review.</p> : null}
    </div>
  );
}
