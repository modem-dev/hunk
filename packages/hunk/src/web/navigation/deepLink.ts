/**
 * Keeps the reader's place in the page address as a semantic review address.
 *
 * The fragment carries `at=<address>` beside any other fragment parameters; the address is
 * the shared grammar (`core/review/address.ts`), built from file keys, hunk indices, sides and
 * lines, and note ids — never rendered rows. The capability is a separate fragment parameter
 * that `session/capability.ts` strips on load; this module never reads or writes it, except
 * that a copied link puts it back on purpose (`reviewLinkWithCapability`).
 *
 * Resolution turns an address into the selection change that shows it, and refuses an
 * address the shown document cannot honor (an unknown file, a hunk past the end, a note that
 * is not stored) rather than guessing a nearby target. A target the review has but this page
 * does not show by shared state (filtered out, an agent note while agent notes are hidden)
 * is named with its reason (a file "Hide viewed" removes is revealed instead, by the page's
 * viewed workflow), and a line is placed as drawn, inside a collapsed gap the page can
 * expand, or absent from the diff, so the page never lands somewhere else without saying so.
 */
import {
  formatReviewAddress,
  parseReviewAddress,
  type ReviewAddress,
} from "../../core/review/address";
import {
  reviewGapId,
  reviewGapSourceForFile,
  reviewLeadingGap,
  reviewTrailingGap,
} from "../../core/review/expansion";
import { reviewHunkRange } from "../../core/review/geometry";
import { reviewFileMatchesFilter, selectStoredReviewNoteById } from "../../core/review/selectors";
import {
  reviewNoteOwnerHunkIndex,
  reviewNoteVisibleByPolicy,
  type ReviewState,
} from "../../core/review/state";
import type { ReviewFileV1, ReviewSide } from "../../core/review/types";

/** The fragment parameter that holds the address. */
export const REVIEW_ADDRESS_FRAGMENT_KEY = "at";

/** The fragment's parameters, without the leading `#`. */
function fragmentParams(hash: string) {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

/** The address a fragment carries, if it is exactly one address. */
export function readFragmentAddress(hash: string): ReviewAddress | undefined {
  const text = fragmentParams(hash).get(REVIEW_ADDRESS_FRAGMENT_KEY);
  return text === null ? undefined : parseReviewAddress(text);
}

/** The fragment with its address replaced (or removed), keeping every other parameter. */
export function fragmentWithAddress(hash: string, address: ReviewAddress | undefined) {
  const params = fragmentParams(hash);
  params.delete(REVIEW_ADDRESS_FRAGMENT_KEY);
  if (address) params.set(REVIEW_ADDRESS_FRAGMENT_KEY, formatReviewAddress(address));
  const text = params.toString();
  return text ? `#${text}` : "";
}

/** The address of where the reader is: the active note, else the selected hunk. */
export function selectionAddress(
  state: Pick<ReviewState, "selection" | "activeNoteId">,
): ReviewAddress | undefined {
  const { fileKey, hunkIndex } = state.selection;
  if (!fileKey) return undefined;
  if (state.activeNoteId) return { kind: "note", fileKey, noteId: state.activeNoteId };
  return { kind: "hunk", fileKey, hunkIndex };
}

/** What showing one address takes: the hunk to select, and an exact line or note to reveal. */
export interface ReviewAddressTarget {
  fileKey: string;
  hunkIndex: number;
  side?: ReviewSide;
  line?: number;
  noteId?: string;
}

/** The hunk whose range holds one line of one side, or the nearest hunk before it. */
function hunkForLine(file: ReviewFileV1, side: ReviewSide, line: number) {
  let nearest = 0;
  for (const [index, hunk] of file.hunks.entries()) {
    const start = side === "new" ? hunk.additionStart : hunk.deletionStart;
    if (start <= line) nearest = index;
  }
  return nearest;
}

/** Why a target the review has is not shown on this page. */
export type ReviewAddressHiddenReason = "filter" | "agent-notes-hidden";

/**
 * Return why one resolvable address points at something this page does not show, if it does.
 *
 * A file the shared filter leaves out and an agent note while agent notes are hidden both
 * exist in the review but have nowhere to be revealed. The page says why instead of landing
 * somewhere else, and never changes the shared filter or note visibility on the reader's
 * behalf. "Hide viewed" is this browser's own choice, not shared state, so a file it removes
 * is not a reason: the jump reveals that file (`viewed/useViewedFiles.ts`), and a viewed file
 * that is only collapsed is expanded.
 */
export function reviewAddressHiddenReason(
  state: ReviewState,
  address: ReviewAddress,
): ReviewAddressHiddenReason | undefined {
  const file = state.document.files.find((candidate) => candidate.key === address.fileKey);
  if (!file) return undefined;
  if (!reviewFileMatchesFilter(file, state.filter)) return "filter";
  if (address.kind === "note") {
    const entry = selectStoredReviewNoteById(state, address.noteId);
    if (entry && !reviewNoteVisibleByPolicy(entry.note, state.showAgentNotes)) {
      return "agent-notes-hidden";
    }
  }
  return undefined;
}

/** The reader-facing sentence for one hidden target. */
export function reviewAddressHiddenMessage(reason: ReviewAddressHiddenReason, path: string) {
  switch (reason) {
    case "filter":
      return `This link points at ${path}, which the shared filter hides. Clear the filter to see it.`;
    case "agent-notes-hidden":
      return `This link points at an agent note in ${path}, and agent notes are hidden. Show them with "a" to see it.`;
  }
}

/** Where one line of one side sits in a file's drawn diff. */
export type ReviewLinePlacement =
  | { kind: "drawn" }
  | { kind: "gap"; gapId: string }
  | { kind: "absent" };

/**
 * Return whether one line is drawn by a hunk, held by a collapsed gap, or not in the diff.
 *
 * A line inside a gap exists in the file but is drawn only once the gap is expanded; a line
 * neither a hunk nor a gap covers (past the end of the file, or beyond what a partial patch
 * knows) cannot be shown at all.
 */
export function reviewLinePlacement(
  file: ReviewFileV1,
  side: ReviewSide,
  line: number,
): ReviewLinePlacement {
  const within = (range: readonly [number, number]) => line >= range[0] && line <= range[1];
  if (file.hunks.some((hunk) => within(reviewHunkRange(hunk, side)))) return { kind: "drawn" };
  const source = reviewGapSourceForFile(file);
  const gaps = [
    ...file.hunks.map((_hunk, index) => reviewLeadingGap(source, index)),
    reviewTrailingGap(source),
  ];
  for (const gap of gaps) {
    if (gap && within(side === "new" ? gap.newRange : gap.oldRange)) {
      return { kind: "gap", gapId: reviewGapId(gap.position, gap.hunkIndex) };
    }
  }
  return { kind: "absent" };
}

/** Resolve one address against the shown review, or refuse it. */
export function resolveReviewAddress(
  state: ReviewState,
  address: ReviewAddress,
): ReviewAddressTarget | undefined {
  const file = state.document.files.find((candidate) => candidate.key === address.fileKey);
  if (!file) return undefined;
  switch (address.kind) {
    case "file":
      return { fileKey: file.key, hunkIndex: 0 };
    case "hunk":
      return address.hunkIndex < Math.max(1, file.hunks.length)
        ? { fileKey: file.key, hunkIndex: address.hunkIndex }
        : undefined;
    case "line":
      return {
        fileKey: file.key,
        hunkIndex: hunkForLine(file, address.side, address.line),
        side: address.side,
        line: address.line,
      };
    case "note": {
      const entry = selectStoredReviewNoteById(state, address.noteId);
      if (!entry || entry.note.fileKey !== file.key) return undefined;
      return {
        fileKey: file.key,
        hunkIndex: reviewNoteOwnerHunkIndex(entry.note),
        noteId: address.noteId,
      };
    }
  }
}
