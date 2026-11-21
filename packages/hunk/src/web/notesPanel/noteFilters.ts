/**
 * The Notes tab's own filters: which authors to show and a text search over note bodies.
 *
 * Local to the panel and to this browser tab — they never change the review's shared filter
 * or what the stream shows. A thread is kept when its root or any reply matches, and is shown
 * whole, so a matching reply never appears without the note it answers.
 */
import type {
  ReviewNoteListEntry,
  ReviewNoteListFile,
  ReviewNoteListOrigin,
} from "../../core/review/noteList";

export interface NoteListFilters {
  origins: ReadonlySet<ReviewNoteListOrigin>;
  text: string;
}

/** Whether one note's text contains the search, case-insensitively. */
function matchesText(entry: ReviewNoteListEntry, needle: string) {
  if (!needle) return true;
  const { summary, rationale, title, author } = entry.note;
  return [summary, rationale, title, author].some((value) =>
    value?.toLocaleLowerCase().includes(needle),
  );
}

/** Keep the threads one note of which passes both filters; drop files left empty. */
export function filterNoteList(
  files: readonly ReviewNoteListFile[],
  filters: NoteListFilters,
): ReviewNoteListFile[] {
  const needle = filters.text.trim().toLocaleLowerCase();
  return files.flatMap((file) => {
    const threads = file.threads.filter((thread) =>
      [thread.root, ...thread.replies].some(
        (entry) => filters.origins.has(entry.origin) && matchesText(entry, needle),
      ),
    );
    return threads.length > 0 ? [{ ...file, threads }] : [];
  });
}

/** Count notes, replies included. */
export function countNoteList(files: readonly ReviewNoteListFile[]) {
  return files.reduce(
    (sum, file) =>
      sum + file.threads.reduce((threads, thread) => threads + 1 + thread.replies.length, 0),
    0,
  );
}
