/**
 * How a review's bulky content is addressed, bounded, and verified.
 *
 * The semantic document says what a review *is*; some of what it refers to — a file's raw
 * patch, its canonical serialized form, the full source text an expanded gap reads from —
 * is too large to hand over in one piece with every publication. Those are resources:
 * addressed by a stable id inside one generation, measured and digested once, and read in
 * bounded chunks that a reader can verify.
 *
 * Only the addressing model lives here. Producing bytes needs an encoder and a hashing
 * runtime, so materialization belongs to the producer tier; core owns the vocabulary both
 * ends validate against, which is what keeps the reader's chunk size from drifting away
 * from the writer's response cap (`docs/browser-review-seam-audit.md`, C2/D5).
 */
import { parseReviewGeneration } from "./generationOrder";
import type { ReviewSide } from "./types";
import { asRecord, hasExactKeys } from "./validation";

export type ReviewResourceKind = "canonical-file" | "patch" | "source";

/** Largest single chunk a reader may ask for, and therefore the largest one served. */
export const REVIEW_RESOURCE_CHUNK_BYTES = 256 * 1024;

/** Largest full source text a producer will read on behalf of gap expansion. */
export const MAX_REVIEW_SOURCE_RESOURCE_BYTES = 1_000_000;

/**
 * How many resources one bulk load produces at a time.
 *
 * Shared because both ends run bulk loads — the producer materializing many patches, the
 * daemon reconstructing them — and a review's memory ceiling is the product of this and
 * the resource bound, so the two must be reasoned about together.
 */
export const REVIEW_RESOURCE_LOAD_CONCURRENCY = 4;

/** Largest single resource of any kind a producer will materialize. */
export const MAX_REVIEW_RESOURCE_BYTES = 32 * 1024 * 1024;

/**
 * The largest a resource of one kind may be, which is what a read reserves against.
 *
 * Stated once because both tiers reserve: the producer before it retains bytes, the mirror
 * before it accepts a stream. Two copies of "source is held to a smaller limit" would be
 * two chances for one of them to keep the general bound after the source bound moved.
 */
export function reviewResourceCeiling(kind: ReviewResourceKind) {
  return kind === "source" ? MAX_REVIEW_SOURCE_RESOURCE_BYTES : MAX_REVIEW_RESOURCE_BYTES;
}

export const REVIEW_CANONICAL_FILE_CONTENT_TYPE =
  "application/vnd.hunk.review-file+json; charset=utf-8" as const;
export const REVIEW_PATCH_CONTENT_TYPE = "text/x-diff; charset=utf-8" as const;
export const REVIEW_SOURCE_CONTENT_TYPE = "text/plain; charset=utf-8" as const;

interface ReviewResourceDescriptorBase {
  id: string;
  generation: string;
  fileKey: string;
  /**
   * Set together once the producer has materialized the content, and never apart: a
   * descriptor that declares one without the other cannot be verified and is a bug.
   */
  byteLength?: number;
  digest?: string;
}

export interface ReviewCanonicalFileResourceV1 extends ReviewResourceDescriptorBase {
  kind: "canonical-file";
  contentType: typeof REVIEW_CANONICAL_FILE_CONTENT_TYPE;
}

export interface ReviewPatchResourceV1 extends ReviewResourceDescriptorBase {
  kind: "patch";
  contentType: typeof REVIEW_PATCH_CONTENT_TYPE;
}

export interface ReviewSourceResourceV1 extends ReviewResourceDescriptorBase {
  kind: "source";
  contentType: typeof REVIEW_SOURCE_CONTENT_TYPE;
  side: ReviewSide;
  /** Identity of the content behind the reader, so a stale read is detectable. */
  sourceIdentity: string;
}

export type ReviewResourceDescriptorV1 =
  | ReviewCanonicalFileResourceV1
  | ReviewPatchResourceV1
  | ReviewSourceResourceV1;

/** Whether one descriptor has been measured, and can therefore be verified when read. */
export function isMaterializedReviewResource(descriptor: ReviewResourceDescriptorV1) {
  return descriptor.byteLength !== undefined && descriptor.digest !== undefined;
}

export interface ReviewResourceAddress {
  kind: ReviewResourceKind;
  fileKey: string;
  /** Only a source resource has a side; the other kinds address the file as a whole. */
  side?: ReviewSide;
}

/**
 * Build the id one resource is addressed by.
 *
 * Derived from the semantic address rather than allocated, so the same file in two
 * generations keeps the same resource ids and a reader can tell that its cached bytes are
 * about the same thing — while the descriptor's generation still says which snapshot the
 * measurement belongs to.
 */
export function reviewResourceId({ kind, fileKey, side }: ReviewResourceAddress) {
  return side === undefined ? `resource:${kind}:${fileKey}` : `resource:${kind}:${side}:${fileKey}`;
}

/** Parse one resource id back into the address it was built from. */
export function parseReviewResourceId(value: unknown): ReviewResourceAddress | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^resource:(canonical-file|patch|source):(?:(old|new):)?(file:[0-9a-f]+)$/.exec(
    value,
  );
  if (!match) {
    return undefined;
  }
  const kind = match[1] as ReviewResourceKind;
  const side = match[2] as ReviewSide | undefined;
  // Only source resources are sided, and every source resource is; anything else was
  // assembled by hand rather than by `reviewResourceId`.
  if ((kind === "source") !== (side !== undefined)) {
    return undefined;
  }
  return { kind, fileKey: match[3]!, ...(side ? { side } : {}) };
}

/** One byte window a reader asks for. */
export interface ReviewResourceRange {
  offset: number;
  length: number;
}

/**
 * Whether one requested window is expressible at all.
 *
 * Bounded by the shared chunk size rather than by whatever the caller felt like, which is
 * the coupling the prototype lost when the client's range size and the server's response
 * cap became two unrelated literals.
 */
export function isReviewResourceRange(value: unknown): value is ReviewResourceRange {
  if (!value || typeof value !== "object") {
    return false;
  }
  const { offset, length } = value as Partial<ReviewResourceRange>;
  return (
    Number.isSafeInteger(offset) &&
    (offset as number) >= 0 &&
    Number.isSafeInteger(length) &&
    (length as number) > 0 &&
    (length as number) <= REVIEW_RESOURCE_CHUNK_BYTES
  );
}

/**
 * One resource read, as an untrusted caller states it.
 *
 * Shared rather than declared per tier: the producer answers these, the wire protocol
 * carries them, and a browser client will compose them — and the moment two of those
 * write their own parser, the reader's range size and the writer's response cap drift
 * apart again (`docs/browser-review-seam-audit.md`, D5).
 */
export interface ReadReviewResourceRequest {
  generation: string;
  resourceId: string;
  offset: number;
  length: number;
}

const READ_RESOURCE_FIELDS = ["generation", "resourceId", "offset", "length"] as const;

/** Parse one resource-read request strictly, rejecting omitted and unknown fields alike. */
export function parseReadReviewResourceRequest(
  value: unknown,
): ReadReviewResourceRequest | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, READ_RESOURCE_FIELDS) ||
    parseReviewGeneration(record.generation) === undefined ||
    typeof record.resourceId !== "string" ||
    record.resourceId.length === 0 ||
    !isReviewResourceRange({ offset: record.offset, length: record.length })
  ) {
    return undefined;
  }
  return record as unknown as ReadReviewResourceRequest;
}

/** One verified slice of a resource, as a reader receives it. */
export interface ReviewResourceChunkV1 {
  generation: string;
  resourceId: string;
  offset: number;
  byteLength: number;
  encoding: "base64";
  data: string;
  /** Digest of the whole resource, not of this chunk: what the reader assembles toward. */
  contentDigest: string;
  contentSize: number;
  eof: boolean;
}

/**
 * What can go wrong reading one resource.
 *
 * Every failure has its own code. In particular a resource whose bytes disagree with the
 * digest they were measured under reports `resource-integrity` and never
 * `unknown-resource` — collapsing the two hides corruption behind a routine miss, and a
 * reader retrying an "unknown" resource is exactly the wrong response to it.
 */
export type ReviewResourceErrorCode =
  /** No descriptor with that id exists in the generation the read named. */
  | "unknown-resource"
  /** The descriptor exists, but its content could not be produced (an unreadable source). */
  | "resource-unavailable"
  /** The content exists but exceeds the bound this resource kind is served under. */
  | "resource-too-large"
  /** The bytes disagree with the length or digest the descriptor declares. */
  | "resource-integrity"
  /** The requested window is unexpressible, or starts past the end of the content. */
  | "invalid-range";

/**
 * What can go wrong with the request itself rather than with the resource it names.
 *
 * Beside the resource codes because every tier that answers a review request — the
 * producer, the wire, later an HTTP surface — reports failures from one vocabulary, and a
 * client that classified a failure differently depending on which tier produced it would
 * be back to inventing its own rules (`docs/browser-review-seam-audit.md`, D5).
 */
export type ReviewRequestErrorCode =
  /** The request named a generation the producer is no longer serving. */
  | "stale-generation"
  /** The request was not expressible: missing, extra, or wrongly typed fields. */
  | "invalid-request";

/**
 * One refused resource operation, in the vocabulary above.
 *
 * Shared by everything that produces or consumes resource bytes — the producer's store,
 * the reader's chunk assembler — so a caller handling one of them handles both, and a code
 * added here reaches every tier at once.
 */
export interface ReviewResourceFailure {
  ok: false;
  code: ReviewResourceErrorCode;
  message: string;
}

/** Build one typed failure without inventing a transport string for it. */
export function reviewResourceFailure(
  code: ReviewResourceErrorCode,
  message: string,
): ReviewResourceFailure {
  return { ok: false, code, message };
}
