/** @jsxImportSource react */
/**
 * The minimap: a narrow overview of the whole review at the stream's right edge.
 *
 * Drawn on a canvas from document geometry — the stream's own body heights and the shared
 * hunk row fractions, projected by `./minimapProjection.ts` — never by reading what the stream
 * drew: file blocks, change ticks in the theme's badge colors, note markers,
 * agent marks, the selected hunk, and a window for the viewport. Files draw as faint neutral
 * blocks with thin change ticks, and a viewed file's block and ticks draw at lower strength. Clicking
 * or dragging scrolls the stream there. It redraws on scroll (one frame at most), on resize,
 * and whenever the review, layout, gaps, notes, or theme change, so a reload, a layout switch,
 * and a gap expansion all stay in step.
 *
 * Mouse only and hidden from assistive technology: the stream itself scrolls from the
 * keyboard, and every mark here names something the stream, sidebar, or Notes tab already
 * reaches.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ReviewRowLayout } from "../../core/review/geometry";
import type { ReviewFile } from "../../core/review/types";
import type { ClientReviewMirrorFileSlot } from "../mirror/clientReviewMirror";
import { STREAM_HEADER_HEIGHT_PX } from "../stream/FileSection";
import type { ReviewStreamController } from "../stream/ReviewStream";
import {
  projectMinimap,
  streamToTrack,
  trackToStreamScroll,
  type MinimapFileInput,
  type MinimapModel,
} from "./minimapProjection";

/** A file section's header plus its bottom border, as the stylesheet lays it out. */
const SECTION_CHROME_PX = STREAM_HEADER_HEIGHT_PX + 1;

export interface MinimapProps {
  slots: readonly ClientReviewMirrorFileSlot[];
  files: ReadonlyMap<string, ReviewFile>;
  layout: ReviewRowLayout;
  noteHunks: ReadonlyMap<string, readonly number[]>;
  highlightHunks: ReadonlyMap<string, readonly number[]>;
  viewed: ReadonlySet<string>;
  selected?: { fileKey: string; hunkIndex: number };
  controller: MutableRefObject<ReviewStreamController | null>;
  /** Changes when the theme does, so the canvas repaints in the new colors. */
  themeKey: string | undefined;
}

/** The theme colors the canvas paints with, read from the root's custom properties. */
function minimapColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    added: read("--hunk-badge-added", "#1a7f37"),
    removed: read("--hunk-badge-removed", "#cf222e"),
    block: read("--hunk-text", "#888"),
    accent: read("--hunk-accent", "#0969da"),
    warning: read("--hunk-file-modified", "#bf8700"),
  };
}

/** Pip gutter on the left; file blocks fill the rest, inset from the right edge. */
const GUTTER_PX = 5;
const BLOCK_INSET_RIGHT_PX = 2;
/** Track pixels between two ticks, and the thickness of one. */
const TICK_PITCH_PX = 2;
const TICK_HEIGHT_PX = 1;
/** Paint strength of blocks and ticks for an open file and a viewed one. */
const OPEN_BLOCK_ALPHA = 0.1;
const VIEWED_BLOCK_ALPHA = 0.035;
const OPEN_TICK_ALPHA = 0.75;
const VIEWED_TICK_ALPHA = 0.22;

/** Paint one model onto the canvas at the device's pixel ratio. */
function paint(canvas: HTMLCanvasElement, model: MinimapModel, width: number) {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(model.trackHeight * ratio);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const colors = minimapColors();
  context.clearRect(0, 0, width, model.trackHeight);

  // Each file is one faint neutral block, separated from its neighbours by a one-pixel gap
  // wherever the band is tall enough to spare it; changes are thin ticks inside the block.
  const blockLeft = GUTTER_PX;
  const blockWidth = Math.max(1, width - blockLeft - BLOCK_INSET_RIGHT_PX);
  for (const file of model.files) {
    const gap = file.height >= 4 ? 1 : 0;
    const height = Math.max(1, file.height - gap);
    context.globalAlpha = file.viewed ? VIEWED_BLOCK_ALPHA : OPEN_BLOCK_ALPHA;
    context.fillStyle = colors.block;
    context.fillRect(blockLeft, file.top, blockWidth, height);

    // One tick per pitch cell that holds changes. A cell with both kinds splits its tick,
    // removals on the left and additions on the right like a split diff, so a modified line
    // does not read as a pure addition.
    context.globalAlpha = file.viewed ? VIEWED_TICK_ALPHA : OPEN_TICK_ALPHA;
    const cell = Math.max(1, Math.round(TICK_PITCH_PX / model.binHeight));
    const first = Math.max(0, Math.floor(file.top / model.binHeight));
    const last = Math.min(model.added.length, Math.ceil((file.top + height) / model.binHeight));
    for (let start = first; start < last; start += cell) {
      let added = 0;
      let removed = 0;
      for (let bin = start; bin < Math.min(last, start + cell); bin += 1) {
        added += model.added[bin]!;
        removed += model.removed[bin]!;
      }
      if (added + removed <= 0) continue;
      const top = start * model.binHeight;
      const share = removed / (added + removed);
      const removedWidth =
        removed <= 0
          ? 0
          : added <= 0
            ? blockWidth
            : Math.min(blockWidth - 2, Math.max(2, Math.round(blockWidth * share)));
      context.fillStyle = colors.removed;
      context.fillRect(blockLeft, top, removedWidth, TICK_HEIGHT_PX);
      context.fillStyle = colors.added;
      context.fillRect(blockLeft + removedWidth, top, blockWidth - removedWidth, TICK_HEIGHT_PX);
    }
  }
  context.globalAlpha = 1;

  // Location marks keep the accent: the selected hunk, agent marks, and note pips.
  if (model.selected) {
    context.fillStyle = colors.accent;
    context.fillRect(0, model.selected.top, 2, Math.max(3, model.selected.height));
  }
  context.fillStyle = colors.warning;
  for (const top of model.highlights) context.fillRect(2, Math.round(top), 3, 3);
  context.fillStyle = colors.accent;
  for (const top of model.notes) {
    context.beginPath();
    context.arc(3, Math.round(top) + 2, 2, 0, Math.PI * 2);
    context.fill();
  }
}

/** The minimap beside the stream. */
export function Minimap(props: MinimapProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const model = useRef<MinimapModel | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const frame = useRef(0);

  // Recompute the model from the stream's current heights and repaint, then move the window.
  const redraw = useCallback(() => {
    const track = trackRef.current;
    const canvas = canvasRef.current;
    const stream = latest.current.controller.current;
    if (!track || !canvas || !stream) return;
    const started = performance.now();
    const current = latest.current;
    const heights = stream.bodyHeights();
    const files = current.slots.map((slot): MinimapFileInput => {
      const file = current.files.get(slot.key);
      // Rows as drawn: a collapsed gap is one separator row, so marks sit where hunks are.
      const drawn = file ? stream.drawnRows(slot.key) : undefined;
      return {
        key: slot.key,
        headerHeight: SECTION_CHROME_PX,
        bodyHeight: heights.get(slot.key) ?? 0,
        stats: slot.index?.stats ?? file?.stats ?? { additions: 0, deletions: 0 },
        ...(file && drawn
          ? {
              rows: {
                ...drawn,
                hunkChanges: file.hunks.map((hunk) => ({
                  additions: hunk.additionLines,
                  deletions: hunk.deletionLines,
                })),
              },
            }
          : {}),
        noteHunks: current.noteHunks.get(slot.key) ?? [],
        highlightHunks: current.highlightHunks.get(slot.key) ?? [],
        viewed: current.viewed.has(slot.key),
      };
    });
    const ratio = window.devicePixelRatio || 1;
    const next = projectMinimap({
      files,
      layout: current.layout,
      trackHeight: track.clientHeight,
      binHeight: 1 / ratio,
      ...(current.selected ? { selected: current.selected } : {}),
    });
    model.current = next;
    // The stream height the track is projected from, so a test can compare it with the stream.
    track.dataset.streamHeight = String(Math.round(next.streamHeight));
    paint(canvas, next, track.clientWidth);
    moveWindow();
    // Named so a performance trace (and the large-review test) can see what a repaint costs.
    performance.measure("hunk-minimap-redraw", { start: started });
  }, []);

  const moveWindow = useCallback(() => {
    const element = latest.current.controller.current?.element();
    const view = windowRef.current;
    const current = model.current;
    if (!element || !view || !current) return;
    const top = streamToTrack(current, element.scrollTop);
    const height = Math.max(6, streamToTrack(current, element.clientHeight));
    view.style.transform = `translateY(${top}px)`;
    view.style.height = `${height}px`;
  }, []);

  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      redraw();
    });
  }, [redraw]);

  // Data, layout, and theme changes repaint.
  useLayoutEffect(() => {
    schedule();
  }, [
    props.slots,
    props.files,
    props.layout,
    props.noteHunks,
    props.highlightHunks,
    props.viewed,
    props.selected,
    props.themeKey,
    schedule,
  ]);

  // Scrolling moves the window and picks up heights measured as files mount; resizing the
  // track or the stream reflows both; the stream's own height changes (wrapping, a viewed file
  // collapsing, a gap or preview drawn) repaint without a scroll.
  useEffect(() => {
    const stream = props.controller.current;
    const element = stream?.element();
    const track = trackRef.current;
    if (!stream || !element || !track) return;
    element.addEventListener("scroll", schedule, { passive: true });
    const stopLayout = stream.subscribeLayout(schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(track);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", schedule);
      stopLayout();
      observer.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [props.controller, schedule]);

  // Press or drag on the track: the viewport centers on the pointer.
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const track = event.currentTarget;
    track.setPointerCapture(event.pointerId);
    const scrollToPointer = (clientY: number) => {
      const stream = latest.current.controller.current;
      const element = stream?.element();
      const current = model.current;
      if (!stream || !element || !current) return;
      const y = clientY - track.getBoundingClientRect().top;
      stream.scrollTo(trackToStreamScroll(current, y, element.clientHeight));
    };
    scrollToPointer(event.clientY);
    const move = (moveEvent: PointerEvent) => scrollToPointer(moveEvent.clientY);
    const end = () => {
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", end);
      track.removeEventListener("pointercancel", end);
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
    event.preventDefault();
  }, []);

  return (
    <div
      className="minimap"
      ref={trackRef}
      aria-hidden="true"
      data-testid="minimap"
      onPointerDown={onPointerDown}
    >
      <canvas ref={canvasRef} className="minimap-canvas" />
      <div ref={windowRef} className="minimap-window" data-testid="minimap-window" />
    </div>
  );
}
