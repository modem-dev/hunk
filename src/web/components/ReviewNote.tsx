/** @jsxImportSource react */
import { Fragment, useState, type ReactNode } from "react";
import type { ReviewNoteV1 } from "../../core/review/types";
import { parseStml, type StmlNode } from "../../core/review/stml";

/** Render every core-projected note field without interpreting ownership or unsafe HTML. */
export function ReviewNote({
  note,
  mutationsEnabled = false,
  onUpdate,
  onRemove,
  editStartRevision = 0,
}: {
  note: ReviewNoteV1;
  mutationsEnabled?: boolean;
  onUpdate?: (body: string, markup: string, editStartRevision: number) => Promise<boolean>;
  onRemove?: () => Promise<boolean>;
  editStartRevision?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.summary);
  const [markupBody, setMarkupBody] = useState(note.markup ?? "");
  const [startedRevision, setStartedRevision] = useState(editStartRevision);
  const markup = note.markup ? parseStml(note.markup).nodes : [];
  const useMarkup = hasRenderableMarkup(markup);
  return (
    <article className={`review-note review-note--${note.source}`} data-note-id={note.id}>
      <header className="review-note__header">
        <span className="review-note__source">{note.source}</span>
        {note.title ? <strong>{note.title}</strong> : null}
        {note.author ? <span>by {note.author}</span> : null}
        {note.createdAt ? (
          <time dateTime={note.createdAt}>{formatTimestamp(note.createdAt)}</time>
        ) : null}
        {note.updatedAt ? (
          <time dateTime={note.updatedAt}>updated {formatTimestamp(note.updatedAt)}</time>
        ) : null}
      </header>
      {useMarkup ? (
        <div className="review-note__markup">{renderNodes(markup)}</div>
      ) : (
        <>
          <p className="review-note__summary">{note.summary}</p>
          {note.rationale ? <p className="review-note__rationale">{note.rationale}</p> : null}
        </>
      )}
      {editing ? (
        <div className="review-note__editor">
          <textarea value={body} onChange={(event) => setBody(event.currentTarget.value)} />
          <label>
            STML markup
            <textarea
              value={markupBody}
              onChange={(event) => setMarkupBody(event.currentTarget.value)}
            />
          </label>
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!body.trim()}
            onClick={() =>
              void onUpdate?.(body, markupBody, startedRevision).then(
                (saved) => saved && setEditing(false),
              )
            }
          >
            Save
          </button>
        </div>
      ) : null}
      <footer className="review-note__meta">
        <span>{note.origin}</span>
        {note.originalSource ? <span>source: {note.originalSource}</span> : null}
        {note.confidence ? <span>{note.confidence} confidence</span> : null}
        {note.tags?.map((tag) => (
          <span key={tag}>#{tag}</span>
        ))}
        {note.origin === "user" && note.editable && onUpdate ? (
          <button
            type="button"
            disabled={!mutationsEnabled}
            onClick={() => {
              setBody(note.summary);
              setMarkupBody(note.markup ?? "");
              setStartedRevision(editStartRevision);
              setEditing(true);
            }}
          >
            Edit
          </button>
        ) : null}
        {(note.origin === "user" || note.origin === "live-agent") && onRemove ? (
          <button type="button" disabled={!mutationsEnabled} onClick={() => void onRemove()}>
            Remove
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function hasRenderableMarkup(nodes: readonly StmlNode[]): boolean {
  return nodes.some((node) =>
    node.type === "text"
      ? node.value.trim().length > 0
      : ["box", "br", "hr", "rule", "divider", "spacer", "space"].includes(node.tag) ||
        hasRenderableMarkup(node.children),
  );
}

function renderNodes(nodes: readonly StmlNode[]): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === "text") return <Fragment key={index}>{node.value}</Fragment>;
    const children = renderNodes(node.children);
    switch (node.tag) {
      case "br":
        return <br key={index} />;
      case "hr":
      case "rule":
      case "divider":
        return <hr key={index} />;
      case "strong":
      case "b":
        return <strong key={index}>{children}</strong>;
      case "em":
      case "i":
        return <em key={index}>{children}</em>;
      case "code":
        return <code key={index}>{children}</code>;
      case "pre":
        return <pre key={index}>{children}</pre>;
      case "ul":
      case "list":
        return <ul key={index}>{children}</ul>;
      case "ol":
        return <ol key={index}>{children}</ol>;
      case "li":
      case "item":
        return <li key={index}>{children}</li>;
      case "p":
      case "row":
      case "box":
        return (
          <div key={index} className={`stml-${node.tag}`}>
            {children}
          </div>
        );
      case "badge":
      case "tag":
        return (
          <span key={index} className="stml-badge">
            {children}
          </span>
        );
      case "spacer":
      case "space":
        return <span key={index}> </span>;
      default:
        return <span key={index}>{children}</span>;
    }
  });
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
