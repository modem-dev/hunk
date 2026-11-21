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
 * thread's cards follow its root and carry its id, so the renderer draws one frame per thread;
 * each card keeps its visible depth, capped at three as in the terminal. Sidecar annotations come first, then stored notes in thread order, which is the
 * order the producer lists them in.
 */
import { reviewCanonicalHunkLine, type ReviewHunkSpan } from "../../core/review/geometry";
import { reviewNoteAge, reviewNoteThreadTitle } from "../../core/review/noteLabels";
import { reviewNoteListOrigin } from "../../core/review/noteList";
import { selectVisibleThreadedStoredReviewNotes } from "../../core/review/selectors";
import {
  reviewNoteAnchorLine,
  reviewNoteOwnerHunkIndex,
  reviewNoteVisibleByPolicy,
  type ReviewState,
} from "../../core/review/state";
import type { ReviewNote, ReviewSide } from "../../core/review/types";
import type { ReviewSharedNote } from "../../session/reviewSharedState";
import { webNoteLocationLabel } from "../format/noteLocation";

/** The deepest reply indent a card shows, as the terminal caps its thread gutter. */
export const MAX_NOTE_THREAD_DEPTH = 3;

/** Who wrote one note, as its card's header names them. */
export interface WebNoteAuthor {
  /** Which avatar the card draws: an agent's or a person's. */
  kind: "agent" | "person";
  /** The author name the note carries, or the origin's plain word (`Agent`, `Reviewer`). */
  name: string;
  /** The quiet role chip (`agent`, `reviewer`, `browser`), left out when it repeats the name. */
  role?: string;
}

/** One note card, ready to draw. */
export interface WebNoteCard {
  id: string;
  /** The id of the thread's root, which is this card's own id for a root. */
  threadId: string;
  note: ReviewNote;
  origin: ReviewSharedNote["origin"];
  stale: boolean;
  /** Reply depth, capped at `MAX_NOTE_THREAD_DEPTH`. */
  depth: number;
  author: WebNoteAuthor;
  /** A compact age (`now`, `5m`), or empty when the note has no timestamp. */
  age: string;
  /** The lines in words (`line 13`, `lines 14–16`, `old line 3`), or `hunk`. */
  location: string;
  /**
   * What the reader may do with it: reply to any stored note, edit an editable reviewer note,
   * and delete a stored one. Sidecar annotations are part of the changeset and take none.
   */
  actions: ("reply" | "edit" | "delete")[];
  /** Draw the actions disabled, because the session that would apply them has ended. */
  actionsDisabled?: boolean;
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
  note: Pick<ReviewNote, "anchor">,
  file: Pick<ReviewDrawnFile, "hunks">,
): { side: ReviewSide; line: number } {
  const anchor = reviewNoteAnchorLine(note);
  if (lineDrawn(file, anchor.side, anchor.line)) return anchor;
  const owner = file.hunks[reviewNoteOwnerHunkIndex(note)];
  return (owner && reviewCanonicalHunkLine(owner, anchor.side)) ?? anchor;
}

/**
 * Where an open composer hangs in the rendered file.
 *
 * A composer opened on a line only an expanded gap drew keeps that line, but once the gap is
 * collapsed (or a reload restores the draft with the gap closed) the line is not drawn, so it
 * hangs from its owner hunk's canonical line instead, as a note card does. An open draft is
 * therefore always visible.
 */
export function reviewComposerPlacement(
  composer: { side: ReviewSide; line: number; hunkIndex: number },
  file: Pick<ReviewDrawnFile, "hunks">,
): { side: ReviewSide; line: number } {
  const own = { side: composer.side, line: composer.line };
  if (lineDrawn(file, own.side, own.line)) return own;
  // A hunk index past the drawn hunks means expansion merged them; the last one owns the tail.
  const owner = file.hunks[Math.min(composer.hunkIndex, file.hunks.length - 1)];
  return (owner && reviewCanonicalHunkLine(owner, own.side)) ?? own;
}

/** The author `notes/add-user` records when its caller names none. */
const DEFAULT_REVIEWER_AUTHOR = "user";

/**
 * Title a note written through the review link, or nothing for any other note.
 *
 * Anyone holding the link may have written it, so it is never "Your note": it names an author
 * the writer gave, or says where it came from.
 */
export function browserNoteTitle(note: ReviewNote, now: number) {
  if (note.originalSource !== "browser") return undefined;
  const author =
    note.author && note.author !== DEFAULT_REVIEWER_AUTHOR ? note.author : "Browser note";
  return reviewNoteThreadTitle({ ...note, source: "agent", author }, now);
}

/** The plain word and role chip each origin falls back to when a note names no author. */
const ORIGIN_WORDS = {
  agent: { name: "Agent", role: "agent" },
  reviewer: { name: "Reviewer", role: "reviewer" },
  browser: { name: "Reviewer", role: "browser" },
} as const;

/**
 * Name who wrote one note: its author, or the plain word for where it came from.
 *
 * Only identity the note carries is used. A note written through the review link is never
 * "You": anyone holding the link may have written it, so it is a reviewer whose chip says it
 * came from a browser. The reviewer's default author (`user`) counts as no name.
 */
export function webNoteAuthor(note: ReviewNote): WebNoteAuthor {
  const origin = reviewNoteListOrigin(note);
  const words = ORIGIN_WORDS[origin];
  const author = note.author?.trim() ?? "";
  const named = origin === "agent" ? author : author === DEFAULT_REVIEWER_AUTHOR ? "" : author;
  const name = named || words.name;
  return {
    kind: origin === "agent" ? "agent" : "person",
    name,
    ...(name.toLowerCase() === words.role ? {} : { role: words.role }),
  };
}

/** Build one card's model. */
function cardFor(
  note: ReviewNote,
  threadId: string,
  origin: WebNoteCard["origin"],
  stale: boolean,
  depth: number,
  now: number,
): WebNoteCard {
  return {
    id: note.id,
    threadId,
    note,
    origin,
    stale,
    depth: Math.min(Math.max(0, depth), MAX_NOTE_THREAD_DEPTH),
    author: webNoteAuthor(note),
    age: reviewNoteAge(note.createdAt, now),
    location: webNoteLocationLabel(note.anchor),
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
  sidecar: readonly ReviewSharedNote[];
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
  const place = (root: ReviewNote) => {
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
      cardFor(entry.note, entry.note.id, "sidecar", entry.resolution === "stale", 0, now),
    );
  }

  // Threads arrive depth-first, so each reply follows its visible root.
  let current: WebNoteGroup | undefined;
  let threadId = "";
  for (const item of selectVisibleThreadedStoredReviewNotes(state)) {
    const { note, resolution } = item.entry;
    if (note.fileKey !== file.key) continue;
    if (item.visibleDepth === 0 || !current) {
      current = place(note);
      threadId = note.id;
    }
    current.cards.push(
      cardFor(
        note,
        threadId,
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
  sidecar: readonly ReviewSharedNote[],
) {
  const counts = new Map<string, number>();
  const add = (fileKey: string) => counts.set(fileKey, (counts.get(fileKey) ?? 0) + 1);
  for (const entry of sidecar) {
    if (reviewNoteVisibleByPolicy(entry.note, state.showAgentNotes)) add(entry.note.fileKey);
  }
  for (const item of selectVisibleThreadedStoredReviewNotes(state)) add(item.entry.note.fileKey);
  return counts;
}
