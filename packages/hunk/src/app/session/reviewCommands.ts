/**
 * Answering brokered review commands from the session that owns the review.
 *
 * The daemon brokers two review commands to a live session: read one bounded slice of a
 * published resource, and apply one semantic action. Both are answered here, at the seam
 * between the wire schema (`packages/hunk/src/session/reviewProtocol.ts`) and the producer that owns
 * the generation (`packages/hunk/src/app/review/producer.ts`), so neither of those has to know about
 * the other's concerns.
 *
 * Three rules shape it:
 *
 * - **One ordering call.** Whether a caller is acting on the review that exists is
 *   answered by `classifyReviewPublication`, not by comparing revisions here
 *   (`docs/browser-review-seam-audit.md`, C1).
 * - **No re-derivation.** A caller addressing a line inside an expanded gap sends the
 *   proof it holds; core resolves it (`resolveReviewExpandedLine`) and the shared anchor
 *   path places the note. Nothing here computes a hunk intersection or an owner, which is
 *   what the prototype's copy got wrong by dropping the fallback branch (D3).
 * - **Facts stay caller-owned.** Core refuses to invent identity or time, and the host is
 *   the caller here, so note and draft ids and timestamps are allocated at this edge.
 */
import { randomUUID } from "node:crypto";
import type { ReviewProducer } from "../review/producer";
import { classifyReviewPublication } from "../../core/review/generationOrder";
import { resolveReviewExpandedLine } from "../../core/review/expansion";
import { requireReviewFile, ReviewIntentPlanningError } from "../../core/review/intents";
import type { ReviewState } from "../../core/review/state";
import type { ReviewFileV1, ReviewLineAddressV1 } from "../../core/review/types";
import {
  toReviewIntent,
  type HunkReviewActionEnvelopeV1,
  type HunkReviewActionResultV1,
  type HunkReviewActionV1,
  type HunkReviewExpandedLineProofV1,
  type HunkReviewFailureCodeV1,
  type HunkReviewFailureV1,
  type HunkReviewResourceReadEnvelopeV1,
  type HunkReviewResourceReadResultV1,
} from "../../session/reviewProtocol";

/** Build one failure carrying the generation the producer is actually serving. */
function fail(
  producer: ReviewProducer,
  code: HunkReviewFailureCodeV1,
  message: string,
): HunkReviewFailureV1 {
  return {
    ok: false,
    code,
    message,
    currentGeneration: producer.getPublication().generation,
  };
}

/**
 * Read one bounded, digest-verified window of one published resource.
 *
 * Everything about the read — strict request parsing, generation checking, single-flight
 * materialization, chunk bounds — already belongs to the producer; this only routes to it.
 * Its answer is already a wire answer: the producer's failure codes are a subset of the
 * wire's, so copying the fields across would only be a second shape of one rejection.
 */
export async function readSessionReviewResource(
  producer: ReviewProducer,
  envelope: HunkReviewResourceReadEnvelopeV1,
): Promise<HunkReviewResourceReadResultV1> {
  return producer.readResource(envelope.request);
}

/**
 * Whether the caller is acting on the review that exists.
 *
 * Two questions, one of them an ordering question. The generation is an addressing check
 * — a request for a generation this producer no longer serves cannot be applied to
 * anything — and the revision is settled by the shared classifier: a producer that has
 * moved *ahead* of the position the caller decided from means the caller acted on a
 * review it can no longer see.
 */
function checkPosition(
  producer: ReviewProducer,
  envelope: HunkReviewActionEnvelopeV1,
): HunkReviewFailureV1 | undefined {
  const current = producer.getPublicationAddress();
  if (envelope.generation !== current.generation) {
    return fail(
      producer,
      "stale-generation",
      `Review generation ${envelope.generation} is not being served; the review is now at ${current.generation}.`,
    );
  }
  if (envelope.expectedStateRevision === undefined) {
    return undefined;
  }
  const claimed = {
    generation: envelope.generation,
    stateRevision: envelope.expectedStateRevision,
  };
  return classifyReviewPublication(claimed, current) === "stale"
    ? undefined
    : fail(
        producer,
        "stale-generation",
        `The review advanced to revision ${current.stateRevision} after ${envelope.expectedStateRevision}; reload before acting on it.`,
      );
}

/**
 * Check one expanded-line proof against the file it claims to be about.
 *
 * The proof is evidence, not an instruction: it says which gap the caller expanded and
 * which content it was reading, and core decides whether the line it names exists. What
 * happens afterwards — which hunk ends up owning a note on that line — is the shared
 * anchor path's answer, reached through the intent, never recomputed here.
 */
function checkExpandedLine(
  producer: ReviewProducer,
  file: ReviewFileV1,
  target: ReviewLineAddressV1,
  proof: HunkReviewExpandedLineProofV1,
): HunkReviewFailureV1 | undefined {
  if (proof.side !== target.side || proof.line !== target.line) {
    return fail(
      producer,
      "invalid-request",
      `The expanded-line proof describes ${proof.side} line ${proof.line}, not the ${target.side} line ${target.line} it accompanies.`,
    );
  }
  return resolveReviewExpandedLine(file, proof)
    ? undefined
    : fail(
        producer,
        "gap-not-found",
        `Review gap ${proof.gapId} in ${file.path} no longer contains ${proof.side} line ${proof.line}.`,
      );
}

/**
 * Validate everything about one action that needs the current review to be known.
 *
 * Resolving a file the action names is core's `requireReviewFile`, so it throws a
 * `ReviewIntentPlanningError` the caller converts — the same rejection, in the same words,
 * a caller would have received had planning reached it.
 */
function checkAgainstReview(
  producer: ReviewProducer,
  state: ReviewState,
  action: HunkReviewActionV1,
): HunkReviewFailureV1 | undefined {
  if (action.type === "notes/start-draft") {
    if (!action.expandedLineProof || !action.target) {
      return undefined;
    }
    const file = requireReviewFile(state, action.fileKey);
    return checkExpandedLine(producer, file, action.target, action.expandedLineProof);
  }

  if (action.type === "notes/create-user" && action.target) {
    // A stated target is a precondition on the draft being saved, so two surfaces cannot
    // silently save each other's work: the draft must still be the one the caller opened.
    const draft = state.draftNote;
    if (!draft || draft.side !== action.target.side || draft.line !== action.target.line) {
      return fail(
        producer,
        "draft-missing",
        `No review note draft is open at ${action.target.side} line ${action.target.line}.`,
      );
    }
    if (!action.expandedLineProof) {
      return undefined;
    }
    const file = requireReviewFile(state, draft.fileKey);
    return checkExpandedLine(producer, file, action.target, action.expandedLineProof);
  }

  return undefined;
}

/**
 * Apply one semantic review action on behalf of a remote caller.
 *
 * The action is lowered to the intent it derives from and planned by the producer against
 * the live store, so a browser firing an action and a keyboard pressing a key reach the
 * same planner with the same facts. The result reports the position the review reached,
 * which is what a caller needs to keep its own ordering straight.
 */
export function applySessionReviewAction(
  producer: ReviewProducer,
  envelope: HunkReviewActionEnvelopeV1,
): HunkReviewActionResultV1 {
  const position = checkPosition(producer, envelope);
  if (position) {
    return position;
  }

  const state = producer.getReviewState();
  if (!state) {
    return fail(
      producer,
      "invalid-request",
      "This session has no live review state attached to act on.",
    );
  }

  try {
    const rejected = checkAgainstReview(producer, state, envelope.action);
    if (rejected) {
      return rejected;
    }

    // Identity and time are the facts core refuses to invent, and this edge is the caller
    // that owns them for a remote action.
    producer.applyIntent(toReviewIntent(envelope.action), {
      draftId: `draft:${randomUUID()}`,
      noteId: `user:${randomUUID()}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof ReviewIntentPlanningError) {
      return fail(producer, error.code, error.message);
    }
    throw error;
  }

  const applied = producer.getPublicationAddress();
  return { ok: true, generation: applied.generation, stateRevision: applied.stateRevision };
}
