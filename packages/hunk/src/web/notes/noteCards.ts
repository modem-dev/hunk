/**
 * Builds the DOM for the note cards that hang beside one diff line.
 *
 * Pierre asks for each line annotation's element and slots it into the diff flow, so cards are
 * plain DOM built here rather than React. A card shows what the terminal's inline note shows:
 * the author-and-age title with the note's lines, a stale mark when the note's context moved,
 * then the body — STML markup rendered by `stmlDom.ts` when it yields anything, otherwise the
 * summary with the rationale beneath it in the muted color. Replies indent by their capped
 * depth under the thread's root. Text is always set as text.
 *
 * Cards the reader may act on carry buttons — Reply, Edit, Delete — named by
 * `data-note-action`; the file view handles them by delegation, so a card stays plain DOM.
 */
import type { WebNoteCard, WebNoteGroup } from "./noteProjection";
import { renderStmlNoteBody } from "./stmlDom";

/** What a card's buttons ask for. */
export type WebNoteCardAction = "reply" | "edit" | "delete";

const ACTION_LABELS: Record<WebNoteCardAction, string> = {
  reply: "Reply",
  edit: "Edit",
  delete: "Delete",
};

/** Build one card. */
export function renderNoteCard(card: WebNoteCard): HTMLElement {
  const article = document.createElement("article");
  article.className = "note-card";
  article.dataset.noteId = card.id;
  article.dataset.origin = card.origin;
  article.dataset.source = card.note.source;
  article.dataset.depth = String(card.depth);
  if (card.stale) article.dataset.stale = "";
  article.style.setProperty("--note-depth", String(card.depth));
  article.setAttribute("aria-label", `${card.title}, ${card.rangeLabel}`);

  const header = document.createElement("header");
  header.className = "note-title";
  const title = document.createElement("span");
  title.className = "note-author";
  title.textContent = card.title;
  const range = document.createElement("span");
  range.className = "note-range";
  range.textContent = card.rangeLabel;
  header.append(title, range);
  if (card.stale) {
    const stale = document.createElement("span");
    stale.className = "note-stale";
    stale.textContent = "stale";
    stale.title = "The code this note is about changed since it was written.";
    header.append(stale);
  }

  const markup = card.note.markup ? renderStmlNoteBody(card.note.markup) : undefined;
  const body = document.createElement("div");
  body.className = "note-body";
  if (markup) {
    body.append(markup);
  } else {
    const summary = document.createElement("p");
    summary.className = "note-summary";
    summary.textContent = card.note.summary;
    body.append(summary);
    if (card.note.rationale) {
      const rationale = document.createElement("p");
      rationale.className = "note-rationale";
      rationale.textContent = card.note.rationale;
      body.append(rationale);
    }
  }

  article.append(header, body);
  if (card.actions.length > 0) {
    const actions = document.createElement("div");
    actions.className = "note-actions";
    for (const action of card.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "note-action";
      button.dataset.noteAction = action;
      button.textContent = ACTION_LABELS[action];
      button.setAttribute("aria-label", `${ACTION_LABELS[action]}: ${card.title}`);
      button.disabled = card.actionsDisabled === true;
      actions.append(button);
    }
    article.append(actions);
  }
  return article;
}

/** Build the stack of cards for one line. */
export function renderNoteGroup(group: WebNoteGroup): HTMLElement {
  const stack = document.createElement("div");
  stack.className = "note-stack";
  stack.dataset.noteSide = group.side;
  stack.dataset.noteLine = String(group.line);
  for (const card of group.cards) stack.append(renderNoteCard(card));
  return stack;
}
