/**
 * What a person is told when a review request is refused.
 *
 * The failure codes are stable and shared — the producer's resource, request, and
 * intent-planning vocabularies, plus the transport's own — but a code is not something to
 * put in front of a reviewer. This is the one place a code becomes a sentence, so the
 * terminal, a browser client, and anything else attached to a review explain the same
 * failure the same way instead of each inventing wording in its own tier
 * (`docs/browser-review-seam-audit.md`, G4).
 *
 * It follows the pattern the repo already uses for the agent surface
 * (`packages/hunk/src/session/agent/errors.ts`): one entry per code, a short statement of what happened
 * and a remedy, single-sourced so no consumer quotes wording nothing throws. The
 * difference is mechanical totality — the catalog is a `Record` over the code union, so a
 * code added to any of the four vocabularies fails to typecheck until it has a message.
 *
 * Two rules for the wording itself:
 *
 * - **Say what happened, then what to do.** A reviewer reading this is mid-task; the
 *   remedy is the part they act on.
 * - **Never interpolate untrusted detail.** The producer's own message may name a file
 *   key or a gap id; the catalog stays constant so it can be rendered anywhere,
 *   including where the caller's input must not be echoed back.
 */
import type { HunkReviewClientErrorCodeV1 } from "./reviewHttpProtocol";

/** One documented failure: what it means, and what the person in front of it can do. */
export interface ReviewErrorDoc {
  /** What happened, in one sentence, in the reviewer's terms. */
  message: string;
  /** What to do about it. */
  remedy: string;
}

/**
 * Every review failure a client can surface, by code.
 *
 * Ordered by tier — the review moved, the request was wrong, the content could not be
 * served, the caller was not allowed — because that is the order a reader diagnoses in.
 */
export const REVIEW_ERROR_CATALOG: Record<HunkReviewClientErrorCodeV1, ReviewErrorDoc> = {
  "stale-generation": {
    message: "The review changed after this request was prepared.",
    remedy: "Reload the review and try again; nothing was applied.",
  },
  "invalid-request": {
    message: "The review request was not expressible.",
    remedy: "This is a client bug rather than something to retry; report it with what you did.",
  },
  "unsupported-action": {
    message: "This Hunk session does not know the action that was requested.",
    remedy: "The client and the session are different versions; update whichever is older.",
  },
  "file-not-found": {
    message: "That file is not part of the review any more.",
    remedy: "Reload the review; the file was removed or the changeset moved on.",
  },
  "hunk-not-found": {
    message: "That hunk is not part of the file any more.",
    remedy: "Reload the review and pick the change again.",
  },
  "gap-not-found": {
    message: "That collapsed region no longer covers the line it was expanded from.",
    remedy: "Reload the file and expand the region again.",
  },
  "draft-missing": {
    message: "There is no open note draft at that line.",
    remedy: "Start the note again; another surface may have saved or cancelled this draft.",
  },
  "draft-active": {
    message: "Another note draft is already open.",
    remedy: "Save or cancel the open draft before starting another one.",
  },
  "draft-mode-mismatch": {
    message: "The open composer is for a different note action.",
    remedy: "Reload the review, then reopen the note action you want.",
  },
  "note-not-found": {
    message: "That note is no longer on the review.",
    remedy: "Reload the review; someone else may have removed it.",
  },
  "note-not-editable": {
    message: "That note cannot be edited.",
    remedy: "Only editable notes written by the reviewer can be changed.",
  },
  "note-has-replies": {
    message: "That note still has replies attached to it.",
    remedy: "Remove its replies first, then remove the note.",
  },
  "note-id-conflict": {
    message: "That note identity is already in use.",
    remedy: "Retry the action so the client allocates a new identity.",
  },
  "invalid-note-parent": {
    message: "The note being replied to is no longer a valid parent.",
    remedy: "Reload the review and choose the comment again.",
  },
  "blank-note": {
    message: "An edited note cannot be blank.",
    remedy: "Enter some text, cancel the edit, or delete the note explicitly.",
  },
  "note-too-large": {
    message: "That note is larger than Hunk can store or publish.",
    remedy: "Shorten the note and try again.",
  },
  "missing-fact": {
    message: "The action arrived without something only its caller can supply.",
    remedy: "This is a client bug rather than something to retry; report it with what you did.",
  },
  "unknown-resource": {
    message: "The review does not offer that content.",
    remedy: "Reload the review; the content belonged to an earlier version of it.",
  },
  "resource-unavailable": {
    message: "Hunk could not read that content from the session that published it.",
    remedy: "The file may have changed on disk. Refresh the session and try again.",
  },
  "resource-too-large": {
    message: "That content is larger than Hunk will send to a review client.",
    remedy: "Open the file in an editor instead; very large files are not reviewed in full here.",
  },
  "resource-integrity": {
    message: "The content that arrived does not match what the session measured.",
    remedy: "Reload the review. If it keeps happening, the file is changing while it is read.",
  },
  "invalid-range": {
    message: "The requested part of that content does not exist.",
    remedy: "This is a client bug rather than something to retry; report it with what you did.",
  },
  unauthorized: {
    message: "This review link is not valid for that session.",
    remedy: "Open the review from the terminal running it to get a current link.",
  },
  "no-publication": {
    message: "That Hunk session is not publishing a review yet.",
    remedy: "Wait for the session to finish loading, then reload.",
  },
  "payload-too-large": {
    message: "The request body is larger than the review surface accepts.",
    remedy: "Split the work into smaller actions.",
  },
  "method-not-allowed": {
    message: "That review route does not answer this kind of request.",
    remedy: "This is a client bug rather than something to retry; report it with what you did.",
  },
  "unsupported-media-type": {
    message: "Review actions must be sent as JSON.",
    remedy: "This is a client bug rather than something to retry; report it with what you did.",
  },
  "forbidden-origin": {
    message: "The review surface only answers requests from this machine.",
    remedy: "Open the review link on the machine running Hunk.",
  },
  "too-many-streams": {
    message: "This review already has as many live connections as it will keep open.",
    remedy: "Close another review tab and reconnect.",
  },
};

/** The sentence and remedy one code stands for. */
export function describeReviewError(code: HunkReviewClientErrorCodeV1): ReviewErrorDoc {
  return REVIEW_ERROR_CATALOG[code];
}

/**
 * One code rendered as the line a client shows.
 *
 * Statement then remedy, joined, because every consumer so far wants both and joining them
 * in each consumer is how two clients end up phrasing the same failure differently.
 */
export function reviewErrorMessage(code: HunkReviewClientErrorCodeV1): string {
  const doc = REVIEW_ERROR_CATALOG[code];
  return `${doc.message} ${doc.remedy}`;
}
