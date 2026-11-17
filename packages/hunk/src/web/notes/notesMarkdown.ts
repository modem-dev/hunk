/**
 * Writes the review's notes as Markdown for the review bar's "Copy notes for agent" button, so
 * a reader can paste them into any agent, issue, or chat.
 *
 * The input is the shared note list (`core/review/noteList.ts`): visible notes only, grouped by
 * file in review order, each thread a root with its replies. Each note names its author the way
 * its card in the stream does (`webNoteAuthor`), its lines in words (`webNoteLocationLabel`),
 * and whether it is stale; its body is the summary followed by the rationale. Replies are
 * nested one list level under the note they answer. Nothing here reads or changes review state.
 */
import type { ReviewNoteListEntry, ReviewNoteListFile } from "../../core/review/noteList";
import { webNoteLocationLabel } from "../format/noteLocation";
import { webNoteAuthor } from "./noteProjection";

export interface ReviewNotesMarkdownOptions {
  /** Agent notes are hidden in the review, so the list left them out; the text says so. */
  agentNotesHidden?: boolean;
}

/** Indent every line of a block by `indent`, leaving blank lines empty. */
function indentLines(text: string, indent: string) {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `${indent}${line}` : ""))
    .join("\n");
}

/** One note's list item: author, location, stale mark, then its body beneath. */
function noteItem(entry: ReviewNoteListEntry, indent: string) {
  const author = webNoteAuthor(entry.note);
  const heading = [
    `**${author.name}**${author.role ? ` (${author.role})` : ""}`,
    webNoteLocationLabel(entry.note.anchor),
    ...(entry.stale ? ["stale"] : []),
  ].join(" · ");
  const body = [entry.note.summary, entry.note.rationale]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  const lines = [`${indent}- ${heading}`];
  if (body) lines.push(indentLines(body, `${indent}  `));
  return lines.join("\n");
}

/** The review's visible notes as one Markdown document, or an empty string when there are none. */
export function formatReviewNotesMarkdown(
  files: readonly ReviewNoteListFile[],
  options: ReviewNotesMarkdownOptions = {},
) {
  if (files.every((file) => file.threads.length === 0)) return "";

  const sections = ["# Review notes"];
  if (options.agentNotesHidden) {
    sections.push("_Agent notes are hidden in this review and are left out._");
  }
  for (const file of files) {
    if (file.threads.length === 0) continue;
    const items = file.threads.map((thread) =>
      [noteItem(thread.root, ""), ...thread.replies.map((reply) => noteItem(reply, "  "))].join(
        "\n",
      ),
    );
    sections.push(`## \`${file.path}\``, items.join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
}
