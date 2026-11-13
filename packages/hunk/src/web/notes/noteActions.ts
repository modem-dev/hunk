/**
 * Turns the reader's note gestures into review actions: save a composer, delete a note.
 *
 * Writes use the session's direct intents — `notes/add-user` for a new note or a reply,
 * `notes/edit-user` for an edit — never the shared draft slot, so composers stay this page's
 * own. Deletion matches the terminal's `D`: a reviewer note is removed with
 * `notes/remove-user`, an agent's live note dismissed with `notes/remove-live`, and a note with
 * replies is refused by the session (`note-has-replies`); sidecar notes are not removable.
 *
 * Two refusals are known before sending and are reported with the session's own sentence
 * without a round trip: a blank body (`blank-note`) and a body over the shared note-size bound
 * (`note-too-large`, measured with `reviewNoteWithinSizeLimit` on the note the session would
 * store). Everything else is the session's answer.
 */
import { isBlankReviewNoteBody } from "../../core/review/intents";
import { reviewNoteWithinSizeLimit } from "../../core/review/noteSize";
import type { ReviewNoteV1 } from "../../core/review/types";
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import type { HunkReviewActionV1 } from "../../session/reviewProtocol";
import type { ReviewActionOutcome, ReviewActionSender } from "../actions/reviewActions";
import type { NoteComposer, NoteComposerStore } from "./composerStore";

/** Why a body is refused before it is sent, if it is. */
export function noteBodyIssue(
  composer: Pick<NoteComposer, "fileKey" | "body">,
): "blank-note" | "note-too-large" | undefined {
  if (isBlankReviewNoteBody(composer.body)) return "blank-note";
  // The note the session would store, with the largest fields it adds filled in.
  const candidate: ReviewNoteV1 = {
    id: "browser:size-check-0000000000000000",
    source: "user",
    originalSource: "browser",
    fileKey: composer.fileKey,
    anchor: { intersectingHunkIndices: [] },
    summary: composer.body.trim(),
    author: "user",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    editable: true,
  };
  return reviewNoteWithinSizeLimit(candidate) ? undefined : "note-too-large";
}

/** The action one composer sends. */
export function noteComposerAction(composer: NoteComposer): HunkReviewActionV1 {
  if (composer.kind === "edit") {
    return { type: "notes/edit-user", noteId: composer.noteId!, body: composer.body };
  }
  return {
    type: "notes/add-user",
    fileKey: composer.fileKey,
    hunkIndex: composer.hunkIndex,
    body: composer.body,
    ...(composer.kind === "reply" ? { parentId: composer.parentId! } : {}),
    ...(composer.kind === "new" && composer.target ? { target: composer.target } : {}),
    ...(composer.kind === "new" && composer.expandedLineProof
      ? { expandedLineProof: composer.expandedLineProof }
      : {}),
  } as HunkReviewActionV1;
}

/**
 * Save one composer; on success it waits, sending, for the shared state to show the note.
 *
 * A save refused for a stale generation is sent again only while `fileContentIdentity` still
 * reports the content the composer was written against: its hunk index and lines mean nothing
 * once that file changed, so a reload that edited it reports the refusal instead.
 */
export async function saveNoteComposer(
  composer: NoteComposer,
  composers: NoteComposerStore,
  sender: Pick<ReviewActionSender, "send">,
  fileContentIdentity: (fileKey: string) => string | undefined,
): Promise<ReviewActionOutcome | undefined> {
  if (composer.status === "sending" || composer.status === "changed") return undefined;
  const issue = noteBodyIssue(composer);
  if (issue) {
    composers.update(composer.key, { status: "failed", error: reviewErrorMessage(issue) });
    return undefined;
  }
  composers.update(composer.key, { status: "sending", error: undefined });
  const outcome = await sender.send(noteComposerAction(composer), {
    stillMeaningful: () => fileContentIdentity(composer.fileKey) === composer.contentIdentity,
  });
  if (outcome.ok) {
    composers.update(composer.key, {
      status: "sending",
      awaiting: {
        generation: outcome.applied.generation,
        stateRevision: outcome.applied.stateRevision,
      },
    });
  } else {
    composers.update(composer.key, { status: "failed", error: outcome.message });
  }
  return outcome;
}

/** The action that removes one stored note, as the terminal's `D` would. */
export function noteRemovalAction(note: Pick<ReviewNoteV1, "id" | "source">): HunkReviewActionV1 {
  return note.source === "user"
    ? { type: "notes/remove-user", noteId: note.id }
    : { type: "notes/remove-live", noteId: note.id };
}
