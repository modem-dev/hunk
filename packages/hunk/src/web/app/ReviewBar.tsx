/** @jsxImportSource react */
/**
 * Lays out the review bar along the bottom of the page: how far through the review the reader
 * is, which file to look at next, the keys that move through a review, and the review's notes.
 *
 * From left to right: viewed progress (moved here from the toolbar), a "Next unviewed" button
 * naming the next file not marked viewed, a quiet row of key hints, a "Shortcuts" button that
 * opens the help overlay, the note count (which opens the Notes tab), and "Copy notes for
 * agent", which copies the visible notes as Markdown. Every key shown comes from the page's
 * resolved keymap through props; the bar names none of its own, binds no keys, and takes no
 * focus. Its actions are page-local (navigation, the side panel, the clipboard), so they keep
 * working after the session ends. Narrow windows drop the key hints (with Shortcuts), then the
 * next file's path, then the note count's word (`styles.css`); the bar never wraps.
 */
import { useState } from "react";
import { Icon } from "../icons/Icon";
import type { ReviewBarHint } from "./reviewBarHints";
import { ViewedProgress } from "./ViewedProgress";

export interface ReviewBarProps {
  progress: { viewed: number; total: number };
  /** The next file not marked viewed, and how to open it; absent when every file is viewed. */
  next?: { path: string; onOpen: () => void };
  /** Key hints read from the page keymap. */
  hints: readonly ReviewBarHint[];
  /** Opens the help overlay, and the chord that does the same. */
  onOpenShortcuts: () => void;
  shortcutsHint?: string;
  /** Visible notes in the review, and how to open the Notes tab. */
  noteCount: number;
  onOpenNotes: () => void;
  notesHint?: string;
  /** Copies the visible notes as Markdown; resolves whether the clipboard took them. */
  onCopyNotes: () => Promise<boolean>;
  /** Agent notes are hidden in the review, so a copy leaves them out. */
  agentNotesHidden: boolean;
}

/** A tooltip naming one action and, when bound, its shortcut. */
function hinted(label: string, hint: string | undefined) {
  return hint ? `${label} (${hint})` : label;
}

/** One path split so the directory truncates and the file name stays readable. */
function SplitPath({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  return (
    <code className="bar-next-path">
      {slash >= 0 ? <span className="bar-next-dir">{path.slice(0, slash + 1)}</span> : null}
      <span className="bar-next-name">{path.slice(slash + 1)}</span>
    </code>
  );
}

/** The copy button's title: what it copies, and why it cannot when it cannot. */
function copyTitle(noteCount: number, agentNotesHidden: boolean) {
  const hidden = agentNotesHidden ? " Agent notes are hidden in this review and are left out." : "";
  return noteCount === 0
    ? `There are no notes in this review to copy.${hidden}`
    : `Copy every visible note as Markdown, grouped by file, to paste into an agent or issue.${hidden}`;
}

/** The review bar. */
export function ReviewBar(props: ReviewBarProps) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copyLabel =
    copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy notes for agent";
  const noteWord = props.noteCount === 1 ? "note" : "notes";

  return (
    <footer className="review-bar" aria-label="Review progress" data-testid="review-bar">
      <ViewedProgress progress={props.progress} />
      {props.next ? (
        <button
          type="button"
          className="bar-button bar-next"
          data-testid="next-unviewed"
          title={`Open the next file not marked viewed: ${props.next.path}`}
          onClick={props.next.onOpen}
        >
          <span className="bar-next-label">Next unviewed</span>
          <SplitPath path={props.next.path} />
        </button>
      ) : props.progress.total > 0 ? (
        <span className="bar-all-viewed" data-testid="all-viewed">
          <Icon name="check" size={13} />
          All files viewed
        </span>
      ) : null}
      <span className="bar-spacer" />
      {/* A visual aid only: the help overlay is the accessible list of shortcuts. */}
      {props.hints.length > 0 ? (
        <span className="bar-keys" aria-hidden="true" data-testid="bar-key-hints">
          {props.hints.map((hint) => (
            <span key={hint.id} className="bar-key" data-hint={hint.id}>
              {hint.keys.map((key, index) => (
                <kbd key={index} className="key-hint">
                  {key}
                </kbd>
              ))}
              <span className="bar-key-label">{hint.label}</span>
            </span>
          ))}
        </span>
      ) : null}
      <button
        type="button"
        className="bar-button bar-shortcuts"
        data-testid="bar-shortcuts"
        title={hinted("Keyboard shortcuts", props.shortcutsHint)}
        onClick={props.onOpenShortcuts}
      >
        {props.shortcutsHint ? (
          <kbd className="key-hint" aria-hidden="true">
            {props.shortcutsHint}
          </kbd>
        ) : null}
        <span className="bar-key-label">Shortcuts</span>
      </button>
      <span className="bar-separator" aria-hidden="true" />
      {props.noteCount > 0 ? (
        <button
          type="button"
          className="bar-button bar-notes"
          data-testid="bar-notes"
          title={hinted("Show every note in the review", props.notesHint)}
          onClick={props.onOpenNotes}
        >
          <Icon name="comment" size={14} />
          <span>
            <span className="bar-notes-count">{props.noteCount}</span>
            <span className="bar-notes-word">{` ${noteWord}`}</span>
          </span>
        </button>
      ) : null}
      <button
        type="button"
        className="tool-button bar-copy"
        data-testid="copy-notes"
        data-state={copied}
        disabled={props.noteCount === 0}
        title={copyTitle(props.noteCount, props.agentNotesHidden)}
        onClick={async () => {
          setCopied((await props.onCopyNotes()) ? "copied" : "failed");
          setTimeout(() => setCopied("idle"), 2_000);
        }}
      >
        <Icon name={copied === "copied" ? "check" : copied === "failed" ? "cross" : "copy"} />
        {/* The name doubles as the result: shown briefly after a copy, announced politely. */}
        <span aria-live="polite">{copyLabel}</span>
      </button>
    </footer>
  );
}
