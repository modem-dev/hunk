/** @jsxImportSource react */
/**
 * The review stream: every file of the review, top to bottom, in review order.
 *
 * Selecting a file in the sidebar scrolls this stream to it; it never narrows the stream to
 * one file. Files mount Pierre only as they approach the viewport and unmount when they are
 * far away, and every unmounted file keeps the height it was last measured at (or the
 * height its row count reserves), so the scrollbar stays stable and a 2,000-file review stays
 * responsive.
 *
 * Four flows move or read the viewport here:
 *
 * - Reveals. The page's local store bumps a reveal token when a selection asks to be shown
 *   (`]`, `.`, a sidebar click): a `file-top` reveal puts the file's header at the top, a
 *   `hunk` reveal puts the selected hunk just under the sticky file header, and `none` leaves
 *   the viewport alone. A hunk in a file that has not mounted yet is scrolled to by estimate
 *   and corrected once the file draws. An agent's reveal (`hunk session navigate`, a comment
 *   added with `--focus`) may name an exact line or note; the hunk reveal then lands on that
 *   line or note card instead of the hunk's first row.
 * - Viewport anchoring. When the reader scrolls by hand — wheel, scrollbar, keys, or the
 *   page's own scroll commands — and the scroll settles, the hunk nearest the viewport's
 *   middle becomes the selection through `selection/anchor`, which never moves a viewport
 *   (`REVIEW_VIEWPORT_ANCHOR_REVEAL`, audit B11). A target the page just revealed holds the
 *   selection for as long as it stays where the reveal put it, so mounting files nearby
 *   cannot steal it.
 * - Scroll commands, through the `controller` this component fills in.
 * - Reloads. A new generation swaps the document under the reader; the stream keeps the file
 *   at the top of the viewport, and the reader's offset inside it, where they were.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { ReviewState } from "../../core/review/state";
import type { ReviewFileV1 } from "../../core/review/types";
import { reviewHunkIndexAtOffset } from "../../core/review/viewportAnchor";
import type { ReviewAgentHighlightV1, ReviewSharedNoteV1 } from "../../session/reviewSharedState";
import type { ReviewMirrorFileSlot } from "../mirror/reviewMirror";
import type { NoteComposer } from "../notes/composerStore";
import type { ReviewNoteInteraction } from "../notes/noteInteraction";
import {
  FileSection,
  reservedBodyHeight,
  STREAM_HEADER_HEIGHT_PX,
  STREAM_ROW_HEIGHT_PX,
  VIEWED_COLLAPSED_HEIGHT_PX,
  type ReviewViewedControls,
} from "./FileSection";
import type { ReviewViewedStatus } from "../viewed/viewedFiles";
import { planReviewFileRender, reviewDrawnRows, type ReviewFileRenderPlan } from "./fileProjection";
import type { ReviewFileGeometry } from "./hunkGeometry";

const NO_HIGHLIGHTS: readonly ReviewAgentHighlightV1[] = [];

/** How far beyond the viewport files mount, and how far before they unmount. */
const MOUNT_MARGIN = "150% 0px 150% 0px";

/** How long a reload keeps re-applying the reader's place while files settle. */
const PIN_AFTER_SWAP_MS = 800;

/**
 * How long the stream's height must hold still before a jump to an edge stops holding it,
 * and the most it holds. Mounting files draw asynchronously (grammars load lazily), so the
 * quiet window covers a slow first draw; the reader's own input releases it sooner.
 */
const EDGE_SETTLE_MS = 1_000;
const EDGE_HOLD_MAX_MS = 5_000;

/** How long scrolling must pause before the viewport counts as settled. */
const SCROLL_SETTLE_MS = 120;

/** How long a reveal into a file that has not drawn yet waits to be corrected. */
const PENDING_REVEAL_MS = 3_000;

/** Space left between the sticky file header and a revealed hunk. */
const REVEAL_MARGIN_PX = 8;

/** How far a held reveal target may drift before the reader is deemed to have moved. */
const HOLD_TOLERANCE_PX = 6;

/** Columns one code-scroll step moves, and how many a Shift step moves (the terminal's 8). */
const CODE_SCROLL_COLUMNS = 1;
const FAST_CODE_SCROLL_COLUMNS = 8;

/** What the page's scroll commands ask of the stream. */
export interface ReviewStreamController {
  /** Scroll by one row, half a viewport, or one viewport, up (-1) or down (1). */
  scroll(direction: -1 | 1, unit: "step" | "half" | "page"): void;
  /** Scroll to the start or the end of the review. */
  scrollToEdge(edge: "top" | "bottom"): void;
  /** Scroll the selected file's code sideways, one column or a fast step. */
  scrollCode(direction: -1 | 1, fast: boolean): void;
  /** The scrolling element, for overviews that follow the viewport (the minimap). */
  element(): HTMLDivElement | null;
  /**
   * Every shown file's body height as the stream lays it out: measured once drawn, reserved
   * from its rows before. An overview projects these instead of reading the DOM.
   */
  bodyHeights(): Map<string, number>;
  /**
   * One loaded file's rows as the stream draws them, with each collapsed gap as its single
   * separator row, so an overview places hunks where they are drawn.
   */
  drawnRows(fileKey: string): ReturnType<typeof reviewDrawnRows> | undefined;
  /**
   * Listen for the stream's heights changing without a scroll: a body drawn taller or
   * shorter (wrapping, a gap, a preview), or a viewed file collapsing or opening.
   */
  subscribeLayout(listener: () => void): () => void;
  /** Scroll the stream to one offset, as the reader moving by hand. */
  scrollTo(top: number): void;
}

export interface ReviewStreamProps {
  slots: readonly ReviewMirrorFileSlot[];
  review: ReviewState;
  layout: "split" | "unified";
  wrapLines: boolean;
  showLineNumbers: boolean;
  syntaxTheme: string;
  appearance: "light" | "dark";
  /** Width of one code column in CSS pixels, for sideways code scrolling. */
  columnWidth: number;
  onToggleGap: (fileKey: string, gapId: string) => void;
  onCollapseGaps: (fileKey: string) => void;
  /** A click on one hunk's rows. */
  onSelectHunk: (fileKey: string, hunkIndex: number) => void;
  /** The generation shown; a change is a reload that keeps the reader's place. */
  generation?: string;
  /** The reader's scroll settled with this hunk nearest the middle of the viewport. */
  onViewportAnchor: (fileKey: string, hunkIndex: number) => void;
  /** Filled in with the stream's scroll commands. */
  controller: MutableRefObject<ReviewStreamController | null>;
  /** The shared snapshot's sidecar annotations. */
  sidecarNotes: readonly ReviewSharedNoteV1[];
  /** Agent attention marks by file key. */
  highlights: Readonly<Record<string, ReviewAgentHighlightV1[]>>;
  /** An exact line or note the next hunk reveal of its file should land on. */
  revealPoint?: ReviewRevealPoint;
  /** Every open composer on the page. */
  composers: readonly NoteComposer[];
  /** What note gestures do. */
  interaction: ReviewNoteInteraction;
  /** Each file's viewed mark as the page shows it. */
  viewedStatuses?: ReadonlyMap<string, ReviewViewedStatus>;
  /** Viewed files whose bodies are collapsed. */
  collapsedFiles?: ReadonlySet<string>;
  /** What the viewed controls do; stable for the page's lifetime. */
  viewed?: ReviewViewedControls;
}

const NO_COLLAPSED: ReadonlySet<string> = new Set();

const NO_COMPOSERS: readonly NoteComposer[] = [];

/** A line or note inside one file, which a hunk reveal lands on instead of the hunk's top. */
export interface ReviewRevealPoint {
  fileKey: string;
  side?: "old" | "new";
  line?: number;
  noteId?: string;
}

/** Where one reveal point is drawn, in stream coordinates, when its file has drawn it. */
function revealPointTop(root: HTMLElement, section: HTMLElement, point: ReviewRevealPoint) {
  const shadow = section.querySelector("diffs-container")?.shadowRoot;
  const scopes: ParentNode[] = shadow ? [section, shadow] : [section];
  let element: Element | null | undefined;
  for (const scope of scopes) {
    if (point.noteId) {
      element = scope.querySelector(`[data-note-id="${CSS.escape(point.noteId)}"]`);
    } else if (point.line !== undefined) {
      element = Array.from(scope.querySelectorAll(`[data-line="${point.line}"]`)).find(
        (candidate) =>
          candidate.closest("[data-code]") !== null &&
          (point.side === "old") ===
            ((candidate.closest("[data-code]")?.hasAttribute("data-deletions") ?? false) ||
              (candidate.getAttribute("data-line-type") ?? "").includes("deletion")),
      );
    }
    if (element) break;
  }
  if (!element) return undefined;
  return element.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
}

/** What a reveal put on screen, and where, so later scrolling can tell if the reader moved. */
interface RevealHold {
  fileKey: string;
  /** Absent for a file-top reveal. */
  hunkIndex?: number;
  /** The target's offset from the top of the viewport right after the reveal. */
  viewportY: number;
  /** Set while the target's file has not drawn and the reveal still needs correcting. */
  pendingUntil?: number;
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

/**
 * Keep the stream at one edge while the files around it settle, and return the release.
 *
 * A jump to an edge lands on the height laid out at that moment, but the files it brings
 * near the viewport then mount and draw at their real heights, and files far above unmount;
 * left alone, the reader ends short of the end. The edge is re-applied each frame until the
 * stream's height has held still for `EDGE_SETTLE_MS` (or `EDGE_HOLD_MAX_MS` passes), and the
 * reader's own wheel, touch, pointer, or key input releases it at once.
 */
function holdScrollEdge(root: HTMLElement, edge: "top" | "bottom") {
  const apply = () => {
    root.scrollTop = edge === "top" ? 0 : root.scrollHeight - root.clientHeight;
  };
  const started = performance.now();
  let height = root.scrollHeight;
  let changedAt = started;
  let frame = 0;
  const step = () => {
    const now = performance.now();
    if (root.scrollHeight !== height) {
      height = root.scrollHeight;
      changedAt = now;
    }
    apply();
    if (now - changedAt < EDGE_SETTLE_MS && now - started < EDGE_HOLD_MAX_MS) {
      frame = requestAnimationFrame(step);
    } else {
      release();
    }
  };
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  const release = () => {
    cancelAnimationFrame(frame);
    for (const input of inputs) root.removeEventListener(input, release);
  };
  for (const input of inputs) root.addEventListener(input, release, { passive: true });
  apply();
  frame = requestAnimationFrame(step);
  return release;
}

/** The section element for one file key. */
function sectionFor(root: HTMLElement, fileKey: string) {
  return root.querySelector<HTMLElement>(`section[data-file-key="${CSS.escape(fileKey)}"]`);
}

/** The first section ending below one offset in the stream, found by bisection. */
function sectionAtOffset(root: HTMLElement, offset: number) {
  // Sections are laid out in order, so bisection finds the answer without walking every file.
  const sections = root.querySelectorAll<HTMLElement>("section[data-file-key]");
  let low = 0;
  let high = sections.length - 1;
  let found: HTMLElement | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const section = sections[middle]!;
    if (section.offsetTop + section.offsetHeight > offset) {
      found = section;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found;
}

/** The scrollable stream of file sections. */
export function ReviewStream(props: ReviewStreamProps) {
  const { slots, review, controller } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState<ReadonlySet<string>>(new Set());
  const heights = useRef(new Map<string, number>());
  const geometries = useRef(new Map<string, ReviewFileGeometry>());
  const planOf = usePlans(review);
  const filesByKey = useMemo(
    () => new Map(review.document.files.map((file) => [file.key, file])),
    [review.document],
  );
  // One array per file, rebuilt only when composers change, so other files skip re-rendering.
  const composersByFile = useMemo(() => {
    const byFile = new Map<string, NoteComposer[]>();
    for (const composer of props.composers) {
      byFile.set(composer.fileKey, [...(byFile.get(composer.fileKey) ?? []), composer]);
    }
    return byFile;
  }, [props.composers]);
  const latest = useRef({ props, filesByKey, planOf });
  latest.current = { props, filesByKey, planOf };

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
              geometries.current.delete(key);
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

  /**
   * Where one reveal target sits in stream coordinates, and whether that is measured.
   *
   * A hunk in a file that has not drawn is placed proportionally through the file's
   * reserved body — close enough to mount the file, after which the reveal is corrected.
   */
  const targetTop = useCallback((fileKey: string, hunkIndex?: number) => {
    const root = scrollRef.current;
    const section = root && sectionFor(root, fileKey);
    if (!root || !section) return undefined;
    if (hunkIndex === undefined) return { top: section.offsetTop, exact: true };
    const point = latest.current.props.revealPoint;
    if (point?.fileKey === fileKey) {
      const top = revealPointTop(root, section, point);
      if (top !== undefined) return { top, exact: true };
    }
    const bodyTop = section.offsetTop + STREAM_HEADER_HEIGHT_PX;
    const measured = geometries.current.get(fileKey)?.hunks[hunkIndex];
    if (measured) return { top: bodyTop + measured.top, exact: true };
    const hunkCount = latest.current.filesByKey.get(fileKey)?.hunks.length ?? 1;
    const bodyHeight = section.offsetHeight - STREAM_HEADER_HEIGHT_PX;
    return { top: bodyTop + (bodyHeight * hunkIndex) / Math.max(1, hunkCount), exact: false };
  }, []);

  // What the last reveal put on screen; scrolling that leaves it in place is not the reader.
  const hold = useRef<RevealHold | undefined>(undefined);
  const releasePin = useRef<(() => void) | undefined>(undefined);
  const layoutListeners = useRef(new Set<() => void>());

  /** Scroll one target into its reveal position and remember where it landed. */
  const reveal = useCallback(
    (fileKey: string, hunkIndex?: number) => {
      const root = scrollRef.current;
      const target = targetTop(fileKey, hunkIndex);
      if (!root || !target) return;
      // An explicit jump wins over keeping the reader's place across a reload.
      releasePin.current?.();
      root.scrollTop =
        hunkIndex === undefined
          ? target.top
          : target.top - STREAM_HEADER_HEIGHT_PX - REVEAL_MARGIN_PX;
      const landed = targetTop(fileKey, hunkIndex) ?? target;
      hold.current = {
        fileKey,
        ...(hunkIndex !== undefined ? { hunkIndex } : {}),
        viewportY: landed.top - root.scrollTop,
        ...(target.exact ? {} : { pendingUntil: performance.now() + PENDING_REVEAL_MS }),
      };
    },
    [targetTop],
  );

  // Only a new reveal request scrolls; a selection made by scrolling or clicking must not.
  const { fileTopToken, hunkToken } = review.reveal;
  const selectedKey = review.selection.fileKey;
  const selectedHunk = review.selection.hunkIndex;
  useEffect(() => {
    if (fileTopToken === 0 || !selectedKey) return;
    reveal(selectedKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileTopToken]);
  useEffect(() => {
    if (hunkToken === 0 || !selectedKey) return;
    reveal(selectedKey, selectedHunk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunkToken]);

  // A file that drew corrects a reveal that had to estimate where its hunk was.
  const onGeometry = useCallback(
    (fileKey: string, geometry: ReviewFileGeometry) => {
      geometries.current.set(fileKey, geometry);
      const held = hold.current;
      if (held?.pendingUntil === undefined || held.fileKey !== fileKey) return;
      if (performance.now() > held.pendingUntil) {
        delete held.pendingUntil;
        return;
      }
      reveal(fileKey, held.hunkIndex);
    },
    [reveal],
  );

  /** Adopt the hunk nearest the middle of the viewport as the selection. */
  const anchorToViewport = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    const held = hold.current;
    if (held) {
      if (held.pendingUntil !== undefined && performance.now() <= held.pendingUntil) return;
      const target = targetTop(held.fileKey, held.hunkIndex);
      if (target && Math.abs(target.top - root.scrollTop - held.viewportY) <= HOLD_TOLERANCE_PX) {
        return;
      }
      hold.current = undefined;
    }

    const center = root.scrollTop + root.clientHeight / 2;
    const section = sectionAtOffset(root, center);
    const fileKey = section?.dataset.fileKey;
    const file = fileKey ? latest.current.filesByKey.get(fileKey) : undefined;
    if (!section || !fileKey || !file) return;
    const offset = center - section.offsetTop - STREAM_HEADER_HEIGHT_PX;
    const geometry = geometries.current.get(fileKey);
    const hunkIndex = geometry
      ? reviewHunkIndexAtOffset(file.hunks.length, (index) => geometry.hunks[index], offset)
      : 0;
    latest.current.props.onViewportAnchor(fileKey, hunkIndex);
  }, [targetTop]);

  // Anchor once scrolling pauses. Wheel, touch, and pointer input also end a pending reveal:
  // the reader has taken over.
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onScroll = useCallback(() => {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(anchorToViewport, SCROLL_SETTLE_MS);
  }, [anchorToViewport]);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const takeOver = () => {
      if (hold.current) delete hold.current.pendingUntil;
    };
    root.addEventListener("wheel", takeOver, { passive: true });
    root.addEventListener("touchstart", takeOver, { passive: true });
    root.addEventListener("pointerdown", takeOver);
    return () => {
      clearTimeout(settleTimer.current);
      root.removeEventListener("wheel", takeOver);
      root.removeEventListener("touchstart", takeOver);
      root.removeEventListener("pointerdown", takeOver);
    };
  }, []);

  // The page's scroll commands. Each is the reader moving by hand, so a pending reveal ends.
  useEffect(() => {
    const scrollBy = (top: number) => {
      const root = scrollRef.current;
      if (!root) return;
      if (hold.current) delete hold.current.pendingUntil;
      // Page keys arrive on the document, not the stream, so they release the reload pin here.
      releasePin.current?.();
      root.scrollTop += top;
    };
    controller.current = {
      element: () => scrollRef.current,
      bodyHeights() {
        const { props: current, filesByKey: files, planOf: plan } = latest.current;
        const result = new Map<string, number>();
        for (const slot of current.slots) {
          const file = files.get(slot.key);
          result.set(
            slot.key,
            current.collapsedFiles?.has(slot.key)
              ? VIEWED_COLLAPSED_HEIGHT_PX
              : (heights.current.get(slot.key) ??
                  reservedBodyHeight(file ? plan(file) : undefined, slot.index, current.layout)),
          );
        }
        return result;
      },
      drawnRows(fileKey) {
        const { filesByKey: files, planOf: plan } = latest.current;
        const file = files.get(fileKey);
        return file ? reviewDrawnRows(plan(file)) : undefined;
      },
      subscribeLayout(listener) {
        layoutListeners.current.add(listener);
        return () => {
          layoutListeners.current.delete(listener);
        };
      },
      scrollTo(top) {
        const root = scrollRef.current;
        if (root) scrollBy(top - root.scrollTop);
      },
      scroll(direction, unit) {
        const root = scrollRef.current;
        if (!root) return;
        const distance =
          unit === "step"
            ? STREAM_ROW_HEIGHT_PX
            : unit === "half"
              ? Math.floor(root.clientHeight / 2)
              : root.clientHeight - STREAM_HEADER_HEIGHT_PX - STREAM_ROW_HEIGHT_PX;
        scrollBy(direction * Math.max(STREAM_ROW_HEIGHT_PX, distance));
      },
      scrollToEdge(edge) {
        const root = scrollRef.current;
        if (!root) return;
        scrollBy(edge === "top" ? -root.scrollTop : root.scrollHeight - root.scrollTop);
        releasePin.current = holdScrollEdge(root, edge);
      },
      scrollCode(direction, fast) {
        const root = scrollRef.current;
        const { props: current } = latest.current;
        const key = current.review.selection.fileKey;
        const shadow = root && key ? sectionFor(root, key)?.querySelector("diffs-container") : null;
        if (!shadow?.shadowRoot) return;
        const columns = fast ? FAST_CODE_SCROLL_COLUMNS : CODE_SCROLL_COLUMNS;
        // Every code column of the file scrolls together, both sides of a split included.
        for (const code of Array.from(
          shadow.shadowRoot.querySelectorAll<HTMLElement>("[data-code]"),
        )) {
          if (code.scrollWidth > code.clientWidth) {
            code.scrollLeft += direction * columns * current.columnWidth;
          }
        }
      },
    };
    return () => {
      releasePin.current?.();
      controller.current = null;
    };
  }, [controller]);

  // Keep the reader's place by file across a document swap.
  const anchor = useRef<{ key: string; offset: number } | undefined>(undefined);
  const topFile = useCallback(() => {
    const root = scrollRef.current;
    const found = root ? sectionAtOffset(root, root.scrollTop) : undefined;
    return found && root
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
      const section = sectionFor(root, saved.key);
      if (section) root.scrollTop = section.offsetTop + saved.offset;
    };
    let frame = 0;
    const deadline = performance.now() + PIN_AFTER_SWAP_MS;
    const step = () => {
      pin();
      if (performance.now() < deadline) frame = requestAnimationFrame(step);
    };
    const release = () => cancelAnimationFrame(frame);
    // One hold at a time: an edge hold still running (a jump to the end just before the
    // reload) stops before this one takes its place, or it would keep pulling to the edge.
    releasePin.current?.();
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

  // Record mounted bodies' real heights so they keep them when they unmount.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const key = (entry.target.parentElement as HTMLElement | null)?.dataset.fileKey;
        if (key && entry.contentRect.height > 0) heights.current.set(key, entry.contentRect.height);
      }
      for (const listener of Array.from(layoutListeners.current)) listener();
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

  // Collapsing or opening a viewed file, wrapping, or a layout switch moves every file below
  // it without a scroll; overviews hear about it here as well as from measured bodies.
  useEffect(() => {
    for (const listener of Array.from(layoutListeners.current)) listener();
  }, [props.collapsedFiles, props.layout, props.wrapLines]);

  return (
    <div
      className="review-stream"
      ref={scrollRef}
      onScroll={onScroll}
      data-testid="review-stream"
      // Focusable so the reader can scroll it with native keys after tabbing to it.
      tabIndex={0}
      role="region"
      aria-label="Review stream"
    >
      {slots.map((slot) => {
        const file = filesByKey.get(slot.key);
        const selected = slot.key === selectedKey;
        return (
          <FileSection
            key={slot.key}
            fileKey={slot.key}
            index={slot.index}
            plan={file ? planOf(file) : undefined}
            mounted={mounted.has(slot.key)}
            measuredHeight={heights.current.get(slot.key)}
            selected={selected}
            {...(selected ? { selectedHunk } : {})}
            layout={props.layout}
            wrapLines={props.wrapLines}
            showLineNumbers={props.showLineNumbers}
            syntaxTheme={props.syntaxTheme}
            appearance={props.appearance}
            onToggleGap={props.onToggleGap}
            onCollapseGaps={props.onCollapseGaps}
            onSelectHunk={props.onSelectHunk}
            onGeometry={onGeometry}
            liveNotes={review.liveNotes}
            userNotes={review.userNotes}
            showAgentNotes={review.showAgentNotes}
            sidecarNotes={props.sidecarNotes}
            highlights={props.highlights[slot.key] ?? NO_HIGHLIGHTS}
            composers={composersByFile.get(slot.key) ?? NO_COMPOSERS}
            interaction={props.interaction}
            {...(props.viewedStatuses?.get(slot.key)
              ? { viewedStatus: props.viewedStatuses.get(slot.key) }
              : {})}
            collapsed={(props.collapsedFiles ?? NO_COLLAPSED).has(slot.key)}
            {...(props.viewed ? { viewed: props.viewed } : {})}
          />
        );
      })}
      {slots.length === 0 ? <p className="stream-empty">No files in this review.</p> : null}
    </div>
  );
}
