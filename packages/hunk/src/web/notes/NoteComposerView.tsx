/** @jsxImportSource react */
/**
 * One note composer, drawn in the diff flow beside the line it is about.
 *
 * Keys follow the terminal's composer: the save chord (`Ctrl+Enter`, `⌘+Enter` on a Mac — the
 * catalog's `ctrl+s` belongs to the browser) saves, and `Esc` cancels, asking first only when
 * the body has text. A failed save keeps the text and shows the session's sentence beneath it;
 * a draft restored onto changed content says so and offers only Discard.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { NoteComposer } from "./composerStore";

/** Whether the page runs on a Mac, where the save chord uses ⌘. */
function isMacPlatform() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** The save chord as the reader's keyboard labels it. */
export function noteSaveChordLabel() {
  return isMacPlatform() ? "⌘+Enter" : "Ctrl+Enter";
}

const TITLES: Record<NoteComposer["kind"], string> = {
  new: "New note",
  reply: "Reply",
  edit: "Edit note",
};

export interface NoteComposerViewProps {
  composer: NoteComposer;
  /** A short description of where the note goes, e.g. `R12–R14`. */
  location: string;
  onChange: (body: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** One composer card. */
export function NoteComposerView({
  composer,
  location,
  onChange,
  onSave,
  onCancel,
}: NoteComposerViewProps) {
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const sending = composer.status === "sending";
  const changed = composer.status === "changed";

  useEffect(() => {
    if (!changed) textRef.current?.focus({ preventScroll: true });
    // Focus once, when the composer opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = () => {
    if (composer.body.trim().length > 0 && !changed) setConfirming(true);
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSave();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <form
      className="note-composer"
      data-composer-key={composer.key}
      data-status={composer.status}
      aria-label={`${TITLES[composer.kind]} at ${location}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <header className="note-title">
        <span className="note-author">{TITLES[composer.kind]}</span>
        <span className="note-range">{location}</span>
      </header>
      <textarea
        ref={textRef}
        className="composer-body"
        value={composer.body}
        rows={Math.min(12, Math.max(3, composer.body.split("\n").length + 1))}
        placeholder="Write a note for this review"
        aria-label="Note text"
        disabled={sending || changed}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {changed ? (
        <p className="composer-message" role="status">
          The lines this draft was written for changed since it was saved. Copy the text if you need
          it, then discard the draft.
        </p>
      ) : null}
      {composer.status === "failed" && composer.error ? (
        <p className="composer-message" data-tone="error" role="alert">
          {composer.error}
        </p>
      ) : null}
      {confirming ? (
        <div className="composer-actions" role="group" aria-label="Discard this draft?">
          <span className="composer-confirm">Discard this draft?</span>
          <button type="button" className="tool-button" onClick={onCancel}>
            Discard
          </button>
          <button
            type="button"
            className="tool-button"
            onClick={() => {
              setConfirming(false);
              textRef.current?.focus();
            }}
          >
            Keep writing
          </button>
        </div>
      ) : (
        <div className="composer-actions">
          <button type="submit" className="tool-button primary" disabled={sending || changed}>
            {sending ? "Saving…" : "Save"}
          </button>
          <button type="button" className="tool-button" onClick={cancel}>
            {changed ? "Discard" : "Cancel"}
          </button>
          <span className="composer-hint">{`${noteSaveChordLabel()} to save · Esc to cancel`}</span>
        </div>
      )}
    </form>
  );
}
