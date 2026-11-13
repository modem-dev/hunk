/**
 * Plans where one file's notes appear in the page's diff flow, and what each card says.
 *
 * Every placement fact comes from the shared model: which notes are visible and how replies
 * nest is `selectVisibleThreadedStoredReviewNotes` (resolution and the agent-notes policy
 * included), sidecar annotations follow `reviewNoteVisibleByPolicy`, and where a note hangs is
 * `reviewNoteAnchorLine` with `reviewNoteOwnerHunkIndex` as the fallback when that line is not
 * on screen — a note anchored to collapsed context hangs from its owner hunk's canonical line
 * (`reviewCanonicalHunkLine`) until the gap opens, so it is never dropped (audit B8). Titles,
 * ages, and line labels are `core/review/noteLabels.ts`.
 *
 * Cards are grouped per anchor line, because Pierre renders one annotation slot per line. A
 * thread renders under its root, replies indented by visible depth capped at three as in the
 * terminal. Sidecar annotations come first, then stored notes in thread order, which is the
 * order the producer lists them in.
 */
import { reviewCanonicalHunkLine, type ReviewHunkSpan } from "../../core/review/geometry";
import { reviewNoteRangeLabel, reviewNoteThreadTitle } from "../../core/review/noteLabels";
import { selectVisibleThreadedStoredReviewNotes } from "../../core/review/selectors";
import {
  reviewNoteAnchorLine,
  reviewNoteOwnerHunkIndex,
  reviewNoteVisibleByPolicy,
  type ReviewState,
} from "../../core/review/state";
import type { ReviewNoteV1, ReviewSide } from "../../core/review/types";
import type { ReviewSharedNoteV1 } from "../../session/reviewSharedState";

/** The deepest reply indent a card shows, as the terminal caps its thread gutter. */
export const MAX_NOTE_THREAD_DEPTH = 3;

/** One note card, ready to draw. */
export interface WebNoteCard {
  id: string;
  note: ReviewNoteV1;
  origin: ReviewSharedNoteV1["origin"];
  stale: boolean;
  /** Reply depth, capped at `MAX_NOTE_THREAD_DEPTH`. */
  depth: number;
  /** `Your note · 5m`, the author name, or `Agent note`. */
  title: string;
  /** GitHub-style lines (`R12–R14`), or `hunk`. */
  rangeLabel: string;
  /**
   * What the reader may do with it: reply to any stored note, edit an editable reviewer note,
   * and delete a stored one. Sidecar annotations are part of the changeset and take none.
   */
  actions: ("reply" | "edit" | "delete")[];
}

/** The cards that hang beside one line of one side. */
export interface WebNoteGroup {
  side: ReviewSide;
  line: number;
  cards: WebNoteCard[];
}

/** The hunks of one file as drawn: the shared model's spans, expanded gaps folded in. */
export interface ReviewDrawnFile {
  key: string;
  hunks: readonly ReviewHunkSpan[];
}

/** Whether one line of one side is drawn by some hunk of the rendered file. */
function lineDrawn(file: Pick<ReviewDrawnFile, "hunks">, side: ReviewSide, line: number) {
  return file.hunks.some((hunk) =>
    side === "new"
      ? line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount
      : line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount,
  );
}

/** Where one root note's cards hang in the rendered file. */
export function reviewNotePlacement(
  note: Pick<ReviewNoteV1, "anchor">,
  file: Pick<ReviewDrawnFile, "hunks">,
): { side: ReviewSide; line: number } {
  const anchor = reviewNoteAnchorLine(note);
  if (lineDrawn(file, anchor.side, anchor.line)) return anchor;
  const owner = file.hunks[reviewNoteOwnerHunkIndex(note)];
  return (owner && reviewCanonicalHunkLine(owner, anchor.side)) ?? anchor;
}

/** The author `notes/add-user` records when its caller names none. */
const DEFAULT_REVIEWER_AUTHOR = "user";

/**
 * Title a note written through the review link, or nothing for any other note.
 *
 * Anyone holding the link may have written it, so it is never "Your note": it names an author
 * the writer gave, or says where it came from.
 */
function browserNoteTitle(note: ReviewNoteV1, now: number) {
  if (note.originalSource !== "browser") return undefined;
  const author =
    note.author && note.author !== DEFAULT_REVIEWER_AUTHOR ? note.author : "Browser note";
  return reviewNoteThreadTitle({ ...note, source: "agent", author }, now);
}

/** Build one card's model. */
function cardFor(
  note: ReviewNoteV1,
  origin: WebNoteCard["origin"],
  stale: boolean,
  depth: number,
  now: number,
): WebNoteCard {
  return {
    id: note.id,
    note,
    origin,
    stale,
    depth: Math.min(Math.max(0, depth), MAX_NOTE_THREAD_DEPTH),
    title: browserNoteTitle(note, now) ?? reviewNoteThreadTitle(note, now),
    rangeLabel: reviewNoteRangeLabel(note.anchor),
    actions:
      origin === "sidecar"
        ? []
        : note.source === "user" && note.editable
          ? ["reply", "edit", "delete"]
          : ["reply", "delete"],
  };
}

export interface PlanReviewFileNotesInput {
  /** The file as rendered, with expanded gaps folded in, so opened context counts as drawn. */
  file: ReviewDrawnFile;
  state: Pick<ReviewState, "liveNotes" | "userNotes" | "showAgentNotes">;
  /** The shared snapshot's sidecar annotations for any file; this file's are picked out. */
  sidecar: readonly ReviewSharedNoteV1[];
  now?: number;
}

/** Plan every visible note of one file into per-line card groups, in review order. */
export function planReviewFileNotes({
  file,
  state,
  sidecar,
  now = Date.now(),
}: PlanReviewFileNotesInput): WebNoteGroup[] {
  const groups = new Map<string, WebNoteGroup>();
  const place = (root: ReviewNoteV1) => {
    const { side, line } = reviewNotePlacement(root, file);
    const key = `${side}:${line}`;
    let group = groups.get(key);
    if (!group) {
      group = { side, line, cards: [] };
      groups.set(key, group);
    }
    return group;
  };

  for (const entry of sidecar) {
    if (entry.note.fileKey !== file.key) continue;
    if (!reviewNoteVisibleByPolicy(entry.note, state.showAgentNotes)) continue;
    place(entry.note).cards.push(
      cardFor(entry.note, "sidecar", entry.resolution === "stale", 0, now),
    );
  }

  // Threads arrive depth-first, so each reply follows its visible root.
  let current: WebNoteGroup | undefined;
  for (const item of selectVisibleThreadedStoredReviewNotes(state)) {
    const { note, resolution } = item.entry;
    if (note.fileKey !== file.key) continue;
    if (item.visibleDepth === 0 || !current) current = place(note);
    current.cards.push(
      cardFor(
        note,
        note.source === "user" ? "user" : "live",
        resolution === "stale",
        item.visibleDepth,
        now,
      ),
    );
  }

  return [...groups.values()];
}

/** How many visible notes each file carries, by file key, for the sidebar's `*N` badge. */
export function countVisibleNotesByFile(
  state: PlanReviewFileNotesInput["state"],
  sidecar: readonly ReviewSharedNoteV1[],
) {
  const counts = new Map<string, number>();
  const add = (fileKey: string) => counts.set(fileKey, (counts.get(fileKey) ?? 0) + 1);
  for (const entry of sidecar) {
    if (reviewNoteVisibleByPolicy(entry.note, state.showAgentNotes)) add(entry.note.fileKey);
  }
  for (const item of selectVisibleThreadedStoredReviewNotes(state)) add(item.entry.note.fileKey);
  return counts;
}
