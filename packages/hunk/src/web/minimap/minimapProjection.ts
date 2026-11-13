/**
 * Projects the review's geometry onto the minimap's track, without reading anything drawn.
 *
 * The stream lays files out as a header plus a body whose height is the measured height once
 * a file has drawn and its reserved row height before (`../stream/FileSection.tsx`); the
 * minimap is handed those same heights, so its proportions are the stream's scroll range scaled
 * to the track. Inside a file, hunks sit at their row fractions from the shared geometry
 * (`reviewHunkRowFractions`); a file whose canonical content has not loaded spreads its stats
 * over its body.
 *
 * The track is coarsened to one bin per device pixel row: every file and hunk adds its added
 * and removed lines to the bins it covers, so the cost is linear in files, hunks, and track
 * pixels whatever the review's size, and a 2,000-file review draws as cheaply as a small one.
 */
import { reviewHunkRowFractions, type ReviewRowLayout } from "../../core/review/geometry";

/** One file as the minimap reads it. */
export interface MinimapFileInput {
  key: string;
  /** Pixels the sticky header takes in the stream. */
  headerHeight: number;
  /** Pixels the body takes in the stream: measured, or reserved before the file draws. */
  bodyHeight: number;
  stats: { additions: number; deletions: number };
  /** Present once the canonical file has loaded; hunks then place the changes. */
  rows?: {
    splitLineCount: number;
    unifiedLineCount: number;
    hunks: Parameters<typeof reviewHunkRowFractions>[0]["hunks"];
    /** Added and removed lines per hunk, in hunk order. */
    hunkChanges: readonly { additions: number; deletions: number }[];
  };
  /** Hunk indices that carry a note. */
  noteHunks?: readonly number[];
  /** Hunk indices that carry an agent attention mark. */
  highlightHunks?: readonly number[];
  viewed?: boolean;
}

/** A vertical span on the track, in track pixels. */
export interface MinimapSpan {
  top: number;
  height: number;
}

export interface MinimapModel {
  /** The stream height the files add up to, in CSS pixels. */
  streamHeight: number;
  trackHeight: number;
  /** Added and removed line weight per track bin; one bin per `binHeight` track pixels. */
  added: Float32Array;
  removed: Float32Array;
  binHeight: number;
  /** File boundaries worth drawing: only where a file's band is at least `minFileBand` tall. */
  boundaries: number[];
  notes: number[];
  highlights: number[];
  viewed: MinimapSpan[];
  selected?: MinimapSpan;
}

export interface MinimapProjectionInput {
  files: readonly MinimapFileInput[];
  layout: ReviewRowLayout;
  trackHeight: number;
  /** Track pixels per bin; one device pixel at the page's scale. */
  binHeight?: number;
  /** Smallest file band, in track pixels, that still draws its boundary. */
  minFileBand?: number;
  selected?: { fileKey: string; hunkIndex: number };
}

/** Add a weight spread evenly across the bins of one track span. */
function spread(
  bins: Float32Array,
  binHeight: number,
  top: number,
  height: number,
  weight: number,
) {
  if (weight <= 0 || bins.length === 0) return;
  const first = Math.max(0, Math.min(bins.length - 1, Math.floor(top / binHeight)));
  const last = Math.max(first, Math.min(bins.length - 1, Math.floor((top + height) / binHeight)));
  const share = weight / (last - first + 1);
  for (let bin = first; bin <= last; bin += 1) bins[bin]! += share;
}

/** Project the files onto a track of the given height; see the module header. */
export function projectMinimap(input: MinimapProjectionInput): MinimapModel {
  const binHeight = input.binHeight ?? 1;
  const trackHeight = Math.max(0, input.trackHeight);
  const streamHeight = input.files.reduce(
    (sum, file) => sum + file.headerHeight + file.bodyHeight,
    0,
  );
  const scale = streamHeight > 0 ? trackHeight / streamHeight : 0;
  const bins = Math.max(0, Math.ceil(trackHeight / binHeight));
  const model: MinimapModel = {
    streamHeight,
    trackHeight,
    added: new Float32Array(bins),
    removed: new Float32Array(bins),
    binHeight,
    boundaries: [],
    notes: [],
    highlights: [],
    viewed: [],
  };
  const minFileBand = input.minFileBand ?? 3;

  let offset = 0;
  for (const file of input.files) {
    const top = offset * scale;
    const band = (file.headerHeight + file.bodyHeight) * scale;
    const bodyTop = (offset + file.headerHeight) * scale;
    const bodyHeight = file.bodyHeight * scale;
    offset += file.headerHeight + file.bodyHeight;
    if (band >= minFileBand) model.boundaries.push(top);
    if (file.viewed) model.viewed.push({ top, height: band });

    const hunkSpans = file.rows
      ? reviewHunkRowFractions(file.rows, input.layout).map((fraction) => ({
          top: bodyTop + fraction.start * bodyHeight,
          height: Math.max(0, (fraction.end - fraction.start) * bodyHeight),
        }))
      : undefined;
    if (hunkSpans && file.rows) {
      hunkSpans.forEach((span, index) => {
        const change = file.rows!.hunkChanges[index] ?? { additions: 0, deletions: 0 };
        spread(model.added, binHeight, span.top, span.height, change.additions);
        spread(model.removed, binHeight, span.top, span.height, change.deletions);
      });
    } else {
      spread(model.added, binHeight, bodyTop, bodyHeight, file.stats.additions);
      spread(model.removed, binHeight, bodyTop, bodyHeight, file.stats.deletions);
    }

    const hunkTop = (index: number) => hunkSpans?.[index]?.top ?? bodyTop;
    for (const index of file.noteHunks ?? []) model.notes.push(hunkTop(index));
    for (const index of file.highlightHunks ?? []) model.highlights.push(hunkTop(index));
    if (input.selected?.fileKey === file.key) {
      const span = hunkSpans?.[input.selected.hunkIndex];
      model.selected = span ?? { top: bodyTop, height: bodyHeight };
    }
  }
  return model;
}

/** The track offset one stream scroll offset maps to. */
export function streamToTrack(
  model: Pick<MinimapModel, "streamHeight" | "trackHeight">,
  offset: number,
) {
  return model.streamHeight > 0 ? (offset / model.streamHeight) * model.trackHeight : 0;
}

/**
 * The stream scroll offset that centers the viewport on one track point, clamped to the
 * stream's scroll range.
 */
export function trackToStreamScroll(
  model: Pick<MinimapModel, "streamHeight" | "trackHeight">,
  trackY: number,
  viewportHeight: number,
) {
  if (model.trackHeight <= 0) return 0;
  const offset = (trackY / model.trackHeight) * model.streamHeight - viewportHeight / 2;
  return Math.max(0, Math.min(Math.max(0, model.streamHeight - viewportHeight), offset));
}
