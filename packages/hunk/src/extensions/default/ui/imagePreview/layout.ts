/**
 * Lays out an image file's before and after versions as file-view rows in the review stream.
 *
 * Captions are ordinary symbolic rows; each image is one fixed-height component row that paints
 * OpenTUI's `<image>`, so Hunk keeps owning measurement, scrolling, and windowing. Heights come
 * from each image's own aspect ratio before paint, which keeps the layout deterministic for a
 * width: a terminal cell is about twice as tall as wide, so one column per source pixel needs half
 * as many rows. Wide sections place the sides next to each other; narrow ones stack them.
 */

import type {
  ExtensionFileViewRow,
  ExtensionFileViewRowComponentProps,
} from "../../../../extension-api/types";
import {
  describeImageChange,
  describeImageSide,
  readImageFacts,
  type ImageFacts,
} from "./describe";

/** One side of the comparison: absent (added/deleted), loaded, or unavailable with a reason. */
export type ImageSideState =
  | { kind: "absent" }
  | { kind: "loaded"; bytes: Uint8Array }
  | { kind: "failed"; reason: string };

export interface ImagePair {
  before: ImageSideState;
  after: ImageSideState;
}

/** Renders images into one fixed-height row; injected so layout stays testable without a renderer. */
export type ImagePainter = (
  images: readonly (Uint8Array | undefined)[],
) => (props: ExtensionFileViewRowComponentProps) => unknown;

// Tall images are capped so one file cannot push the rest of the review far down the stream.
export const MAX_IMAGE_ROWS = 24;
// Below this width two sides would each be too narrow to read, so they stack instead.
export const SIDE_BY_SIDE_MIN_WIDTH = 60;
export const SIDE_GAP = 3;

interface Side {
  label: "Before" | "After";
  state: ImageSideState;
  facts?: ImageFacts;
  error?: string;
}

/** Resolve a side's facts once, turning undecodable bytes into a caption-worthy reason. */
function toSide(label: Side["label"], state: ImageSideState): Side {
  if (state.kind !== "loaded") return { label, state };
  const facts = readImageFacts(state.bytes);
  return "error" in facts ? { label, state, error: facts.error } : { label, state, facts };
}

/** Rows an image needs at `columns` wide: one column per pixel, two pixels per row, within caps. */
export function imageRows(facts: ImageFacts, columns: number) {
  const drawnColumns = Math.max(1, Math.min(columns, facts.width));
  return Math.min(
    MAX_IMAGE_ROWS,
    Math.max(1, Math.ceil((drawnColumns * facts.height) / facts.width / 2)),
  );
}

/** Caption for one side, including why it cannot be drawn. */
function caption(side: Side) {
  if (side.state.kind === "absent") {
    return `${side.label} · none, the image was ${side.label === "Before" ? "added" : "deleted"}`;
  }
  if (side.state.kind === "failed") return `${side.label} · can't show: ${side.state.reason}`;
  if (side.error) return `${side.label} · can't show: ${side.error}`;
  return `${side.label} · ${describeImageSide(side.facts!)}`;
}

/** Return the bytes to draw for a side, or undefined when it shows only a caption. */
function drawable(side: Side) {
  return side.state.kind === "loaded" && side.facts ? side.state.bytes : undefined;
}

/** Pad or cut text to exactly `width` columns so side-by-side captions line up. */
function fit(text: string, width: number) {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

/** Build the file-view rows for one image pair at `width` columns. */
export function layoutImagePair(
  pair: ImagePair,
  width: number,
  paint: ImagePainter,
): ExtensionFileViewRow[] {
  const sides = [toSide("Before", pair.before), toSide("After", pair.after)];
  const [before, after] = sides as [Side, Side];
  const summary =
    before.facts && after.facts ? describeImageChange(before.facts, after.facts) : undefined;
  const rows: ExtensionFileViewRow[] = summary
    ? [{ id: "summary", spans: [{ text: summary, tone: "muted" }] }]
    : [];
  const tone = (side: Side) =>
    side.state.kind === "failed" || side.error ? ("removed" as const) : undefined;

  const beforeBytes = drawable(before);
  const afterBytes = drawable(after);
  if (beforeBytes && afterBytes && width >= SIDE_BY_SIDE_MIN_WIDTH) {
    const columns = Math.floor((width - SIDE_GAP) / 2);
    const height = Math.max(imageRows(before.facts!, columns), imageRows(after.facts!, columns));
    rows.push({
      id: "captions",
      spans: [
        {
          text: `${fit(caption(before), columns)}${" ".repeat(SIDE_GAP)}${fit(caption(after), columns)}`.trimEnd(),
        },
      ],
    });
    rows.push({
      id: "images",
      spans: [{ text: "[before and after images]", tone: "muted" }],
      component: { height, render: paint([beforeBytes, afterBytes]) },
    });
    return rows;
  }

  for (const side of sides) {
    const id = side.label.toLowerCase();
    rows.push({ id: `${id}-caption`, spans: [{ text: caption(side), tone: tone(side) }] });
    const bytes = drawable(side);
    if (!bytes) continue;
    rows.push({
      id: `${id}-image`,
      spans: [{ text: `[${id} image]`, tone: "muted" }],
      component: { height: imageRows(side.facts!, width), render: paint([bytes]) },
    });
  }
  return rows;
}
