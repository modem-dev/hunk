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
 * is not stored) rather than guessing a nearby target.
 */
import {
  formatReviewAddress,
  parseReviewAddress,
  type ReviewAddress,
} from "../../core/review/address";
import { selectStoredReviewNoteById } from "../../core/review/selectors";
import { reviewNoteOwnerHunkIndex, type ReviewState } from "../../core/review/state";
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
