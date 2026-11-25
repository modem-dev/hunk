/**
 * Builds the DOM for the note threads that hang beside one diff line.
 *
 * Pierre asks for each line annotation's element and slots it into the diff flow, so threads
 * are plain DOM built here rather than React. Each thread is one card: its root and replies are
 * messages separated by hairlines, and a note with no replies is a card with one message. A
 * message shows an avatar (an agent's or a person's), then one header shape — author, role
 * chip, age when the note has a timestamp, the lines in words, a stale mark when the note's
 * context moved — then the body: STML markup rendered by `stmlDom.ts` when it yields anything,
 * otherwise the summary with the rationale beneath it in the muted color. Text is always set
 * as text, and once a message is built its bidi controls and invisible characters become
 * visible markers (`../format/RevealedText.tsx`): an agent's words are repository-grade input.
 *
 * A message the reader may act on carries icon buttons — Reply, Edit, Delete — named by
 * `data-note-action`, and a thread that takes replies ends in a quiet "Reply…" row. The file
 * view handles both by delegation, so a card stays plain DOM. An open reply or edit composer for
 * a note in the thread is drawn at the thread's foot in place of that row.
 *
 * The active note is marked with `data-active` on its message and its thread. `markActiveNote`
 * moves that mark in place, so changing the active note never rebuilds a card or its height.
 */
import { revealReviewHiddenText } from "../../core/review/hiddenText";
import { revealHiddenCharactersIn } from "../format/RevealedText";
import { createIconElement } from "../icons/Icon";
import type { IconName } from "../icons/iconPaths";
import type { WebNoteCard, WebNoteGroup } from "./noteProjection";
import { renderStmlNoteBody } from "./stmlDom";

/** What a card's buttons ask for. */
export type WebNoteCardAction = "reply" | "edit" | "delete";

/** The shortcut each action's key has in the page keymap, where it has one. */
export type WebNoteActionHints = Readonly<Partial<Record<WebNoteCardAction, string>>>;

const ACTION_LABELS: Record<WebNoteCardAction, string> = {
  reply: "Reply",
  edit: "Edit",
  delete: "Delete",
};

const ACTION_ICONS: Record<WebNoteCardAction, IconName> = {
  reply: "reply",
  edit: "pencil",
  delete: "trash",
};

/** How one line's threads are drawn beyond what the plan says. */
export interface WebNoteGroupRenderOptions {
  hints?: WebNoteActionHints;
  /** The active note, whose message and thread carry `data-active`. */
  activeNoteId?: string | null;
  /** Open composer hosts that belong at a thread's foot, by thread id. */
  threadComposers?: ReadonlyMap<string, readonly HTMLElement[]>;
}

/** An action's name with its shortcut, as both its tooltip and its accessible name. */
export function noteActionLabel(action: WebNoteCardAction, hints: WebNoteActionHints = {}) {
  const hint = hints[action];
  return hint ? `${ACTION_LABELS[action]} (${hint})` : ACTION_LABELS[action];
}

/** Build one text span. */
function span(className: string, text: string) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}

/** Build one message's header: who, role, age, where, stale mark, then the actions. */
function renderHeader(card: WebNoteCard, hints: WebNoteActionHints) {
  const header = document.createElement("header");
  header.className = "note-title";
  // The words wrap in a narrow column; the actions keep their place at the right.
  const meta = document.createElement("span");
  meta.className = "note-meta";
  meta.append(span("note-author", card.author.name));
  if (card.author.role) meta.append(span("note-role", card.author.role));
  if (card.age) meta.append(span("note-age", card.age));
  meta.append(span("note-range", card.location));
  if (card.stale) {
    const stale = span("note-stale", "stale");
    stale.title = "The code this note is about changed since it was written.";
    meta.append(stale);
  }
  header.append(meta);

  if (card.actions.length > 0) {
    const actions = document.createElement("span");
    actions.className = "note-actions";
    for (const action of card.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "note-action";
      button.dataset.noteAction = action;
      const label = noteActionLabel(action, hints);
      button.setAttribute("aria-label", label);
      button.title = label;
      button.disabled = card.actionsDisabled === true;
      button.append(createIconElement(ACTION_ICONS[action], 14));
      actions.append(button);
    }
    header.append(actions);
  }
  return header;
}

/** Build one message's body: STML markup when it renders, else summary and rationale. */
function renderBody(card: WebNoteCard) {
  const markup = card.note.markup ? renderStmlNoteBody(card.note.markup) : undefined;
  const body = document.createElement("div");
  body.className = "note-body";
  if (markup) {
    body.append(markup);
    return body;
  }
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
  return body;
}

/** Build one message of a thread. */
export function renderNoteCard(card: WebNoteCard, hints: WebNoteActionHints = {}): HTMLElement {
  const article = document.createElement("article");
  article.className = "note-card";
  article.dataset.noteId = card.id;
  article.dataset.origin = card.origin;
  article.dataset.source = card.note.source;
  article.dataset.depth = String(card.depth);
  if (card.stale) article.dataset.stale = "";
  article.setAttribute(
    "aria-label",
    revealReviewHiddenText(
      [card.author.name, card.author.role, card.age, card.location].filter(Boolean).join(", "),
    ),
  );

  const avatar = document.createElement("span");
  avatar.className = "note-avatar";
  avatar.dataset.kind = card.author.kind;
  avatar.setAttribute("aria-hidden", "true");
  avatar.append(createIconElement(card.author.kind === "agent" ? "spark" : "person", 13));

  const main = document.createElement("div");
  main.className = "note-main";
  main.append(renderHeader(card, hints), renderBody(card));

  article.append(avatar, main);
  // Cards hold no composer (those are React roots beside them), so marking in place is safe.
  revealHiddenCharactersIn(article);
  return article;
}

/** Build the quiet row that opens a reply to one thread. */
function renderReplyRow(root: WebNoteCard, hints: WebNoteActionHints) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "note-reply-row";
  row.dataset.noteAction = "reply";
  row.dataset.noteId = root.id;
  row.title = "Reply to this thread";
  row.disabled = root.actionsDisabled === true;
  row.append(createIconElement("reply", 14), span("note-reply-field", "Reply…"));
  // The key replies to the active note, so it is shown only on the active thread.
  if (hints.reply) {
    const key = span("note-reply-key", hints.reply);
    key.setAttribute("aria-hidden", "true");
    row.append(key);
  }
  return row;
}

/** Build one thread's card from its messages, root first. */
function renderThread(cards: readonly WebNoteCard[], options: WebNoteGroupRenderOptions) {
  const root = cards[0]!;
  const hints = options.hints ?? {};
  const thread = document.createElement("div");
  thread.className = "note-thread";
  thread.dataset.threadId = root.threadId;
  if (root.stale) thread.dataset.stale = "";
  for (const card of cards) thread.append(renderNoteCard(card, hints));

  const composers = options.threadComposers?.get(root.threadId) ?? [];
  if (composers.length > 0) {
    const foot = document.createElement("div");
    foot.className = "note-thread-composers";
    foot.append(...composers);
    thread.append(foot);
  } else if (root.actions.includes("reply")) {
    thread.append(renderReplyRow(root, hints));
  }
  return thread;
}

/** Split one line's cards into threads, keeping their order. */
export function groupNoteThreads(cards: readonly WebNoteCard[]): WebNoteCard[][] {
  const threads: WebNoteCard[][] = [];
  for (const card of cards) {
    const last = threads.at(-1);
    if (last && last[0]!.threadId === card.threadId) last.push(card);
    else threads.push([card]);
  }
  return threads;
}

/**
 * Move the active mark within one subtree to the note given, or clear it.
 *
 * The mark sits on the note's message and on the thread that holds it, so the thread takes the
 * accent ring and the message is told apart within it.
 */
export function markActiveNote(root: ParentNode, noteId: string | null | undefined) {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-active]"))) {
    if (element.matches(".note-card, .note-thread")) delete element.dataset.active;
  }
  if (!noteId) return;
  for (const card of Array.from(root.querySelectorAll<HTMLElement>(".note-card[data-note-id]"))) {
    if (card.dataset.noteId !== noteId) continue;
    card.dataset.active = "";
    const thread = card.closest<HTMLElement>(".note-thread");
    if (thread) thread.dataset.active = "";
  }
}

/** Build the threads for one line. */
export function renderNoteGroup(
  group: WebNoteGroup,
  options: WebNoteGroupRenderOptions = {},
): HTMLElement {
  const stack = document.createElement("div");
  stack.className = "note-stack";
  stack.dataset.noteSide = group.side;
  stack.dataset.noteLine = String(group.line);
  for (const cards of groupNoteThreads(group.cards)) stack.append(renderThread(cards, options));
  markActiveNote(stack, options.activeNoteId);
  return stack;
}
