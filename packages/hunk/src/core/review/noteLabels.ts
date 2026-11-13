/**
 * Words a review note card shows around its body: who wrote it, how long ago, and where.
 *
 * Every surface titles a note the same way — "Your note" for the reviewer's own, the author's
 * name or "Agent note" otherwise, then a compact age — and names its lines GitHub-style
 * (`R12`, `L3–L5`). The terminal draws these into fixed cells and sanitizes them for a
 * terminal first; the browser draws them as text. Neither restates the rules.
 */
import type { ReviewNoteSource } from "../run/commandInputs";
import type { ReviewLineRange } from "./types";

/** Format a compact, stable-enough age for a saved note's title (`now`, `5m`, `3h`, `2d`). */
export function reviewNoteAge(createdAt: string | undefined, now = Date.now()) {
  const timestamp = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return "";
  }

  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d`;
  const elapsedWeeks = Math.floor(elapsedDays / 7);
  if (elapsedWeeks < 52) return `${elapsedWeeks}w`;
  return `${Math.floor(elapsedWeeks / 52)}y`;
}

/** Who a threaded note card names: the reviewer, its author, or an anonymous agent. */
export function reviewNoteAuthorLabel(source: ReviewNoteSource, author: string | undefined) {
  const name = author?.trim() ?? "";
  return source === "user" ? "Your note" : name || "Agent note";
}

/** The author-and-age title a threaded note card shows (`Your note · 5m`). */
export function reviewNoteThreadTitle(
  note: { source: ReviewNoteSource; author?: string; createdAt?: string },
  now = Date.now(),
) {
  const age = reviewNoteAge(note.createdAt, now);
  return `${reviewNoteAuthorLabel(note.source, note.author)}${age ? ` · ${age}` : ""}`;
}

/** Format one inclusive line range GitHub-style: `R12`, or `R12–R14`. */
export function reviewNoteLineRangeLabel(prefix: "L" | "R", range: ReviewLineRange) {
  return range[0] === range[1]
    ? `${prefix}${range[0]}`
    : `${prefix}${range[0]}–${prefix}${range[1]}`;
}

/** Name the lines one note covers (`L3 → R4–R6`), or `hunk` when it names none. */
export function reviewNoteRangeLabel(ranges: {
  oldRange?: ReviewLineRange;
  newRange?: ReviewLineRange;
}) {
  const parts: string[] = [];
  if (ranges.oldRange) parts.push(reviewNoteLineRangeLabel("L", ranges.oldRange));
  if (ranges.newRange) parts.push(reviewNoteLineRangeLabel("R", ranges.newRange));
  return parts.join(" → ") || "hunk";
}
