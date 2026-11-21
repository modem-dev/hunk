/**
 * Names the lines a note covers in words, for the browser page's note cards, composers, and
 * Notes tab: `line 13`, `lines 14–16`, `old line 13`.
 *
 * This is a display string only. The anchor data is untouched, and agents and the terminal
 * keep their GitHub-style `R13` / `L3–L5` notation from `core/review/noteLabels.ts`.
 */
import type { ReviewLineRange } from "../../core/review/types";

/** One inclusive range on one side, in words (`line 13`, `old lines 3–5`). */
function sideRangeLabel(side: "old" | "new", range: ReviewLineRange) {
  const prefix = side === "old" ? "old " : "";
  return range[0] === range[1]
    ? `${prefix}line ${range[0]}`
    : `${prefix}lines ${range[0]}–${range[1]}`;
}

/**
 * Name the lines one note covers, or `hunk` when it names none.
 *
 * A note spanning both sides names the old range first, joined by an arrow as the terminal's
 * label joins them (`old line 3 → lines 4–6`).
 */
export function webNoteLocationLabel(ranges: {
  oldRange?: ReviewLineRange;
  newRange?: ReviewLineRange;
}) {
  const parts: string[] = [];
  if (ranges.oldRange) parts.push(sideRangeLabel("old", ranges.oldRange));
  if (ranges.newRange) parts.push(sideRangeLabel("new", ranges.newRange));
  return parts.join(" → ") || "hunk";
}
