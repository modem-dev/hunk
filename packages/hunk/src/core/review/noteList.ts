/**
 * Lists every visible note of a review as threads grouped by file, in review order.
 *
 * A notes overview — the browser's Notes tab, and later `hunk session` or a terminal pane —
 * reads this instead of re-deriving order or threading. Stored notes come from
 * `selectNavigableStoredReviewNotes`, which is the order keyboard note navigation walks and
 * already applies the visibility and resolution policies; sidecar annotations, which never
 * enter the store, are placed beside them by the same owner hunk and anchor line, ahead of
 * stored notes on the same line as the terminal draws them. A thread is its visible root
 * with its visible replies, depth-first.
 */
import {
  reviewNoteCurrentOwnerHunkIndex,
  selectNavigableStoredReviewNotes,
  selectVisibleReviewFiles,
} from "./selectors";
import { reviewNoteAnchorLine, reviewNoteVisibleByPolicy, type ReviewState } from "./state";
import type { ReviewNoteV1 } from "./types";

/** Who wrote a note, as a notes list filters it. */
export type ReviewNoteListOrigin = "agent" | "reviewer" | "browser";

/** One note in a thread, with the facts a list shows beside it. */
export interface ReviewNoteListEntry {
  note: ReviewNoteV1;
  origin: ReviewNoteListOrigin;
  stale: boolean;
  /** Whether the note is stored (live or reviewer) rather than a sidecar annotation. */
  stored: boolean;
}

/** One visible root and its visible replies. */
export interface ReviewNoteListThread {
  root: ReviewNoteListEntry;
  replies: ReviewNoteListEntry[];
  fileKey: string;
  hunkIndex: number;
  line: number;
}

/** One file's threads. */
export interface ReviewNoteListFile {
  fileKey: string;
  path: string;
  threads: ReviewNoteListThread[];
}

/** Classify one note's author for filtering: an agent, the reviewer, or a browser tab. */
export function reviewNoteListOrigin(note: ReviewNoteV1): ReviewNoteListOrigin {
  if (note.source !== "user") return "agent";
  return note.originalSource === "browser" ? "browser" : "reviewer";
}

type NoteListState = Pick<
  ReviewState,
  | "activeNoteId"
  | "document"
  | "filter"
  | "liveNotes"
  | "selection"
  | "showAgentNotes"
  | "userNotes"
>;

/** List the review's visible notes as threads by file; see the module header. */
export function selectReviewNoteList(
  state: NoteListState,
  sidecar: readonly { note: ReviewNoteV1; resolution: "active" | "stale" }[] = [],
): ReviewNoteListFile[] {
  const files = selectVisibleReviewFiles(state);
  const fileOrder = new Map(files.map((file, index) => [file.key, index] as const));
  const fileByKey = new Map(files.map((file) => [file.key, file] as const));

  // Sidecar annotations are roots in their own right; sort keys put them first on a line.
  const placed: Array<{ thread: ReviewNoteListThread; order: [number, number, number, number] }> =
    [];
  sidecar.forEach(({ note, resolution }, arrival) => {
    const file = fileByKey.get(note.fileKey);
    if (!file || file.hunks.length === 0) return;
    if (!reviewNoteVisibleByPolicy(note, state.showAgentNotes)) return;
    const hunkIndex = reviewNoteCurrentOwnerHunkIndex(note, file);
    const line = reviewNoteAnchorLine(note).line;
    placed.push({
      thread: {
        root: {
          note,
          origin: reviewNoteListOrigin(note),
          stale: resolution === "stale",
          stored: false,
        },
        replies: [],
        fileKey: file.key,
        hunkIndex,
        line,
      },
      order: [fileOrder.get(file.key)!, hunkIndex, line, arrival],
    });
  });

  const storedThreads = new Map<string, ReviewNoteListThread>();
  selectNavigableStoredReviewNotes(state).forEach((item, position) => {
    const entry: ReviewNoteListEntry = {
      note: item.entry.note,
      origin: reviewNoteListOrigin(item.entry.note),
      stale: item.entry.resolution === "stale",
      stored: true,
    };
    const existing = item.visibleDepth > 0 ? storedThreads.get(item.rootId) : undefined;
    if (existing) {
      existing.replies.push(entry);
      return;
    }
    const thread: ReviewNoteListThread = {
      root: entry,
      replies: [],
      fileKey: item.fileKey,
      hunkIndex: item.hunkIndex,
      line: item.line,
    };
    storedThreads.set(item.rootId, thread);
    placed.push({
      thread,
      order: [fileOrder.get(item.fileKey)!, item.hunkIndex, item.line, sidecar.length + position],
    });
  });

  placed.sort((left, right) => {
    for (let index = 0; index < 4; index += 1) {
      const difference = left.order[index]! - right.order[index]!;
      if (difference !== 0) return difference;
    }
    return 0;
  });

  const result: ReviewNoteListFile[] = [];
  for (const { thread } of placed) {
    const last = result.at(-1);
    if (last?.fileKey === thread.fileKey) {
      last.threads.push(thread);
    } else {
      result.push({
        fileKey: thread.fileKey,
        path: fileByKey.get(thread.fileKey)!.path,
        threads: [thread],
      });
    }
  }
  return result;
}
