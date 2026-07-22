// Placement and sizing for the inline agent note card.
//
// This is the single source of truth for how wide a note card is and where it
// docks. It is shared by the card renderer, the planned-row height
// measurement, and the live markup-width reporting that tells agents what
// width their STML will actually be laid out at — all three must agree or
// note heights and agent feedback drift from what the terminal shows.

import type { LayoutMode } from "../../core/types";
import { resolveSplitPaneWidths } from "../diff/codeColumns";

export interface AgentNoteGeometryInput {
  anchorSide?: "old" | "new";
  layout: Exclude<LayoutMode, "auto">;
  /** Diff pane content width (the `width` prop the diff view renders at). */
  width: number;
}

export interface AgentNoteBoxLayout {
  /** Total card width including its borders. */
  boxWidth: number;
  /** Columns of left padding before the card starts. */
  boxLeft: number;
  /** Width the note body (summary text or STML markup) is laid out at. */
  contentWidth: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Resolve the note card's box placement for one anchor side and pane width. */
export function agentNoteBoxLayout({
  anchorSide,
  layout,
  width,
}: AgentNoteGeometryInput): AgentNoteBoxLayout {
  // Docked notes align to the same column split the side-by-side diff uses.
  const splitWidths = resolveSplitPaneWidths(width);
  const canDockRight = layout === "split" && anchorSide === "new" && width >= 84;
  const canDockLeft = layout === "split" && anchorSide === "old" && width >= 84;
  const preferredDockWidth = canDockRight
    ? splitWidths.rightWidth
    : canDockLeft
      ? splitWidths.leftWidth
      : Math.max(34, width - 4);
  const boxWidth = clamp(preferredDockWidth, 28, Math.max(28, width - 4));
  const boxLeft = canDockRight
    ? Math.max(0, width - boxWidth)
    : canDockLeft
      ? 0
      : Math.min(4, Math.max(0, width - boxWidth));
  const innerWidth = Math.max(1, boxWidth - 2);
  const contentWidth = Math.max(1, innerWidth - 2);

  return { boxWidth, boxLeft, contentWidth };
}

/** The width STML markup in a note body is laid out at for this geometry. */
export function agentNoteMarkupWidth(input: AgentNoteGeometryInput): number {
  return agentNoteBoxLayout(input).contentWidth;
}
