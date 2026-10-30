/**
 * The one ordering contract for published review state.
 *
 * A review is published as a sequence of generations, and each generation as a sequence of
 * state revisions. Every party that receives those publications — the producer checking
 * its own output, the broker mirroring it, later a browser client applying it — has to
 * answer the same question about an arriving publication: is it ahead, behind, or ahead in
 * a way that cannot be applied incrementally? The prototype answered it five times with
 * three different rules, including one client that required contiguous `+1` revisions the
 * server never promised (`docs/browser-review-seam-audit.md`, C1). This module is that
 * answer, stated once.
 *
 * The invariant, in full:
 *
 * - A generation identity names its producer and carries a monotonic sequence. Two
 *   generations are ordered only when they came from the same producer.
 * - A producer's generation sequence increases by exactly one per reload. It never
 *   decreases and never skips.
 * - Within one generation, state revisions strictly increase but need **not** be
 *   contiguous: a receiver that joined late, replayed a log, or took a fresh snapshot
 *   legitimately sees jumps. A revision that repeats is a replay, not an update.
 * - Across generations, revisions are not comparable at all, since a new generation may
 *   restart them. A generation change is therefore classified as its own verdict rather
 *   than folded into revision comparison.
 *
 * Non-semantic republication (a renderer width changed, nothing about the review did) is
 * *not* modelled here. It carries no new position, so it classifies as a replay; whoever
 * needs to re-emit it decides that on its own publication key rather than by loosening
 * this comparison.
 */

export interface ReviewGenerationIdentity {
  /** Which producer minted the generation; generations from two producers never order. */
  producerId: string;
  /** Monotonic per-producer counter. The only ordering fact a generation carries. */
  sequence: number;
}

/** Serialized generation prefix, so a malformed string is rejected rather than guessed at. */
const REVIEW_GENERATION_PREFIX = "generation";

/** Producer ids are opaque but may not contain the separator the serialized form uses. */
const REVIEW_PRODUCER_ID_BODY = "[A-Za-z0-9._-]+";
const REVIEW_PRODUCER_ID_PATTERN = new RegExp(`^${REVIEW_PRODUCER_ID_BODY}$`);

/**
 * The serialized form, built from the prefix and producer-id rule the formatter writes by.
 *
 * A hand-written twin of this is what let the two disagree: a sequence the formatter
 * accepted could be one the parser refused. The digit bound is only wide enough to keep
 * the match cheap — every safe integer fits in sixteen digits — and `Number.isSafeInteger`
 * below remains the actual gate on the value.
 */
const REVIEW_GENERATION_PATTERN = new RegExp(
  `^${REVIEW_GENERATION_PREFIX}:(${REVIEW_PRODUCER_ID_BODY}):(\\d{1,16})$`,
);

/** Render one generation identity as the opaque string every surface passes around. */
export function formatReviewGeneration({ producerId, sequence }: ReviewGenerationIdentity) {
  if (!REVIEW_PRODUCER_ID_PATTERN.test(producerId)) {
    throw new Error(`Review producer id ${JSON.stringify(producerId)} is not addressable.`);
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Review generation sequence ${sequence} is not a non-negative integer.`);
  }
  return `${REVIEW_GENERATION_PREFIX}:${producerId}:${sequence}`;
}

/** Parse one serialized generation, or undefined when it is not one at all. */
export function parseReviewGeneration(value: unknown): ReviewGenerationIdentity | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = REVIEW_GENERATION_PATTERN.exec(value);
  if (!match) {
    return undefined;
  }
  const sequence = Number(match[2]);
  return Number.isSafeInteger(sequence) ? { producerId: match[1]!, sequence } : undefined;
}

/** The generation one producer publishes after the given one. */
export function nextReviewGeneration({
  producerId,
  sequence,
}: ReviewGenerationIdentity): ReviewGenerationIdentity {
  return { producerId, sequence: sequence + 1 };
}

/**
 * Where one publication sits in its producer's sequence.
 *
 * `stateRevision` is the review store's own monotonic counter; the generation is what
 * makes two of them comparable.
 */
export interface ReviewPublicationAddress {
  generation: string;
  stateRevision: number;
}

/**
 * The verdict on an arriving publication.
 *
 * - `accepted` — the same generation, strictly further along. Apply it.
 * - `gap` — a later generation of the same producer. Ordered ahead, but nothing from the
 *   old generation carries over, so a receiver must take a fresh snapshot before applying
 *   anything from it.
 * - `stale` — anything else: an earlier or equal position, a replay, a foreign producer,
 *   or an identity that does not parse. Nothing to do.
 */
export type ReviewPublicationOrder = "accepted" | "stale" | "gap";

/** Classify one arriving publication against the position a receiver already holds. */
export function classifyReviewPublication(
  current: ReviewPublicationAddress,
  incoming: ReviewPublicationAddress,
): ReviewPublicationOrder {
  const currentGeneration = parseReviewGeneration(current.generation);
  const incomingGeneration = parseReviewGeneration(incoming.generation);
  if (!currentGeneration || !incomingGeneration) {
    return "stale";
  }
  if (currentGeneration.producerId !== incomingGeneration.producerId) {
    // Two producers publish two unrelated sequences; neither supersedes the other, and
    // adopting one over the other by number would silently mix two reviews.
    return "stale";
  }
  if (incomingGeneration.sequence !== currentGeneration.sequence) {
    return incomingGeneration.sequence > currentGeneration.sequence ? "gap" : "stale";
  }
  return incoming.stateRevision > current.stateRevision ? "accepted" : "stale";
}

/** Raised when a producer would publish a position that breaks the ordering invariant. */
export class ReviewPublicationOrderError extends Error {
  override readonly name = "ReviewPublicationOrderError";
}

/**
 * The producer's own side of the contract, asserted before anything is published.
 *
 * A producer may only move forward, and only in the two shapes a receiver knows how to
 * handle: a further revision of the generation it is already serving, or the very next
 * generation. Anything else — a repeated position, a skipped generation, a foreign
 * identity — is a producer bug, and failing here is what keeps it from becoming a
 * receiver's unexplained desync.
 */
export function assertReviewPublicationAdvance(
  current: ReviewPublicationAddress,
  next: ReviewPublicationAddress,
) {
  const verdict = classifyReviewPublication(current, next);
  if (verdict === "stale") {
    throw new ReviewPublicationOrderError(
      `Review publication ${next.generation}@${next.stateRevision} does not advance ` +
        `${current.generation}@${current.stateRevision}.`,
    );
  }
  if (verdict === "gap") {
    const currentGeneration = parseReviewGeneration(current.generation)!;
    const nextGeneration = parseReviewGeneration(next.generation)!;
    if (nextGeneration.sequence !== currentGeneration.sequence + 1) {
      throw new ReviewPublicationOrderError(
        `Review generation ${next.generation} skips ahead of ${current.generation}; ` +
          "producers advance one generation at a time.",
      );
    }
  }
}
