/** @jsxImportSource react */
import { Fragment, type ReactNode } from "react";
import type { ReviewNoteV1 } from "../../core/review/types";
import { parseStml, type StmlNode } from "../../core/review/stml";

/** Render every core-projected note field without interpreting ownership or unsafe HTML. */
export function ReviewNote({ note }: { note: ReviewNoteV1 }) {
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
      <footer className="review-note__meta">
        <span>{note.origin}</span>
        {note.originalSource ? <span>source: {note.originalSource}</span> : null}
        {note.confidence ? <span>{note.confidence} confidence</span> : null}
        {note.tags?.map((tag) => (
          <span key={tag}>#{tag}</span>
        ))}
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
