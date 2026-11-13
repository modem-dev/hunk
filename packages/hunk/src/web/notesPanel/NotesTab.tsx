/** @jsxImportSource react */
/**
 * The Notes tab: every visible note in the review, as threads grouped by file.
 *
 * Order and threading are the shared note list's (`core/review/noteList.ts`), which is the
 * order keyboard note navigation walks. The author and text filters are this panel's own
 * (`./noteFilters.ts`) and change nothing else on the page. A thread shows its root and a
 * reply count until expanded. Choosing a note selects it in the page's store with a reveal, so
 * the stream scrolls to its card; nothing reaches the session. Read-only: notes are written
 * and edited in the stream.
 */
import { useMemo, useState } from "react";
import { reviewNoteRangeLabel, reviewNoteThreadTitle } from "../../core/review/noteLabels";
import type {
  ReviewNoteListEntry,
  ReviewNoteListFile,
  ReviewNoteListOrigin,
  ReviewNoteListThread,
} from "../../core/review/noteList";
import { browserNoteTitle } from "../notes/noteProjection";
import { countNoteList, filterNoteList } from "./noteFilters";

export interface NotesTabProps {
  files: readonly ReviewNoteListFile[];
  activeNoteId: string | null;
  /** Whether agent notes are hidden in this review, which hides them here too. */
  agentNotesHidden: boolean;
  onSelectNote: (thread: ReviewNoteListThread, entry: ReviewNoteListEntry) => void;
}

const ORIGINS: readonly [ReviewNoteListOrigin, string][] = [
  ["agent", "Agent"],
  ["reviewer", "Reviewer"],
  ["browser", "Browser"],
];

/** The note's title as its card in the stream shows it. */
function titleOf(note: ReviewNoteListEntry["note"], now: number) {
  return browserNoteTitle(note, now) ?? reviewNoteThreadTitle(note, now);
}

/** One note's row. */
function NoteRow({
  thread,
  entry,
  active,
  now,
  onSelect,
}: {
  thread: ReviewNoteListThread;
  entry: ReviewNoteListEntry;
  active: boolean;
  now: number;
  onSelect: NotesTabProps["onSelectNote"];
}) {
  const range = reviewNoteRangeLabel(entry.note.anchor);
  return (
    <button
      type="button"
      className="notes-row"
      data-origin={entry.origin}
      data-active={active ? "" : undefined}
      aria-current={active ? "true" : undefined}
      data-testid="notes-row"
      onClick={() => onSelect(thread, entry)}
    >
      <span className="notes-row-title">
        <span className="notes-author">{titleOf(entry.note, now)}</span>
        {range ? <span className="notes-range">{range}</span> : null}
        {entry.stale ? <span className="note-stale">stale</span> : null}
      </span>
      <span className="notes-summary">{entry.note.summary}</span>
    </button>
  );
}

/** The Notes tab body. */
export function NotesTab({ files, activeNoteId, agentNotesHidden, onSelectNote }: NotesTabProps) {
  const [origins, setOrigins] = useState<ReadonlySet<ReviewNoteListOrigin>>(
    () => new Set(ORIGINS.map(([origin]) => origin)),
  );
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const shown = useMemo(() => filterNoteList(files, { origins, text }), [files, origins, text]);
  const total = countNoteList(files);
  const now = Date.now();

  const toggleOrigin = (origin: ReviewNoteListOrigin) =>
    setOrigins((current) => {
      const next = new Set(current);
      if (next.has(origin)) next.delete(origin);
      else next.add(origin);
      return next;
    });
  const toggleThread = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (total === 0) {
    return (
      <div className="notes-empty" data-testid="notes-empty">
        <p>No notes in this review yet.</p>
        <p className="muted">
          Agents add notes with <code>hunk session comment add</code> or an agent-context file;
          notes you write in the stream appear here too.
          {agentNotesHidden ? " Agent notes are hidden in this session." : ""}
        </p>
      </div>
    );
  }

  return (
    <div className="notes-panel" data-testid="notes-panel">
      <div className="notes-controls">
        <input
          type="search"
          className="notes-search"
          placeholder="Search notes"
          aria-label="Search notes"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="notes-origins" role="group" aria-label="Show notes by">
          {ORIGINS.map(([origin, label]) => (
            <button
              key={origin}
              type="button"
              className="tool-button toggle-button notes-origin"
              aria-pressed={origins.has(origin)}
              data-testid={`notes-origin-${origin}`}
              onClick={() => toggleOrigin(origin)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="notes-count" role="status">
          {countNoteList(shown) === total
            ? `${total} ${total === 1 ? "note" : "notes"}`
            : `${countNoteList(shown)} of ${total} notes`}
          {agentNotesHidden ? " · agent notes hidden" : ""}
        </p>
      </div>
      {shown.length === 0 ? <p className="notes-none">No notes match.</p> : null}
      {shown.map((file) => (
        <section key={file.fileKey} className="notes-file" aria-label={file.path}>
          <h3 className="notes-file-path" title={file.path}>
            {file.path}
          </h3>
          <ul className="notes-threads">
            {file.threads.map((thread) => {
              const id = thread.root.note.id;
              const open = expanded.has(id);
              const replies = thread.replies.length;
              return (
                <li key={id} className="notes-thread">
                  <NoteRow
                    thread={thread}
                    entry={thread.root}
                    active={activeNoteId === id}
                    now={now}
                    onSelect={onSelectNote}
                  />
                  {replies > 0 ? (
                    <button
                      type="button"
                      className="notes-replies-toggle"
                      aria-expanded={open}
                      onClick={() => toggleThread(id)}
                    >
                      {`${open ? "▾" : "▸"} ${replies} ${replies === 1 ? "reply" : "replies"}`}
                    </button>
                  ) : null}
                  {open ? (
                    <ul className="notes-replies">
                      {thread.replies.map((reply) => (
                        <li key={reply.note.id}>
                          <NoteRow
                            thread={thread}
                            entry={reply}
                            active={activeNoteId === reply.note.id}
                            now={now}
                            onSelect={onSelectNote}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
