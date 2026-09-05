/**
 * The event contract a review stream speaks: frame names, envelopes, ids, and bounds.
 *
 * One review can be watched by more than one surface at a time, so the daemon pushes what
 * changed instead of making each watcher poll. The push side is Server-Sent Events, and
 * everything about how an event is put on the wire is stated here — once, for both ends.
 *
 * That is the whole reason this module exists. The prototype built frame names, begin/end
 * envelopes, and the event-id grammar inside its server and then re-declared them (and
 * regex-parsed them) in its client, with byte bounds on the two sides that were merely
 * coincidentally compatible: a payload the server would send was one the client would
 * refuse (`docs/browser-review-seam-audit.md`, C4). Here the server imports these
 * definitions, and the browser client will import the same ones unchanged — which is what
 * makes the module browser-safe by construction, gated as such by
 * `scripts/source-boundaries.test.ts`.
 *
 * Three properties worth stating up front:
 *
 * - **A payload larger than one chunk is a resource-shaped byte stream.** It is framed with
 *   the same size/digest/offset/eof facts a review resource carries and read back by the
 *   same `ReviewChunkAssembler`, because "reassemble bounded chunks and verify them" is a
 *   solved problem in this codebase and a second loop is exactly what C2 was about.
 * - **Bounds are derived, never chosen twice.** The largest payload is the protocol's
 *   envelope bound; the chunk size is the shared resource chunk size; the chunk ceiling is
 *   the quotient. A client cannot hold a smaller ceiling than the server without changing
 *   the constant both import.
 * - **Only a complete event carries an `id:`.** A `Last-Event-ID` therefore always names a
 *   whole event rather than a position inside a half-delivered payload, so a resuming
 *   client can never reconstruct a torn one.
 */
import { REVIEW_RESOURCE_CHUNK_BYTES, type ReviewResourceChunkV1 } from "../core/review/resources";
import {
  parseReviewGeneration,
  type ReviewPublicationAddress,
} from "../core/review/generationOrder";
import { ReviewChunkAssembler, type ReviewAssemblyResult } from "../core/review/resourceAssembly";
import { hasExactKeys, isReviewSha256Digest, type ReviewDigestFn } from "../core/review/validation";
import { MAX_HUNK_REVIEW_ENVELOPE_BYTES, MAX_HUNK_REVIEW_IDENTIFIER_BYTES } from "./reviewProtocol";

/**
 * What a review stream can announce.
 *
 * `publication` is the whole of the review's position and catalog as the daemon mirrors
 * it; `disconnect` says the session behind the stream is gone and no further event is
 * coming. There is deliberately no separate "state changed" event: the daemon mirrors a
 * publication, not a `ReviewState`, so one event type describes everything it knows.
 */
export const REVIEW_EVENT_TYPES = ["publication", "disconnect"] as const;

export type ReviewEventTypeV1 = (typeof REVIEW_EVENT_TYPES)[number];

/** Which part of a chunked event one frame carries. */
export type ReviewEventFramePhase = "begin" | "chunk" | "end";

const REVIEW_EVENT_FRAME_PHASES: readonly ReviewEventFramePhase[] = ["begin", "chunk", "end"];

/** Largest serialized event payload this stream carries, in bytes. */
export const MAX_REVIEW_EVENT_PAYLOAD_BYTES = MAX_HUNK_REVIEW_ENVELOPE_BYTES;

/** Largest slice of a payload one chunk frame carries. */
export const REVIEW_EVENT_CHUNK_BYTES = REVIEW_RESOURCE_CHUNK_BYTES;

/** How many chunk frames the largest payload can possibly need. */
export const MAX_REVIEW_EVENT_CHUNKS = Math.ceil(
  MAX_REVIEW_EVENT_PAYLOAD_BYTES / REVIEW_EVENT_CHUNK_BYTES,
);

/** Largest event id, held to the same bound as every other identifier on the wire. */
export const MAX_REVIEW_EVENT_ID_BYTES = MAX_HUNK_REVIEW_IDENTIFIER_BYTES;

/** Content type one review event stream is served as. */
export const REVIEW_EVENT_STREAM_CONTENT_TYPE = "text/event-stream; charset=utf-8";

/**
 * Keep-alive line.
 *
 * An SSE comment rather than an event, so a reader that only dispatches events never sees
 * it, while every proxy and idle-connection timer between the two ends does.
 */
export const REVIEW_EVENT_HEARTBEAT_FRAME = ": hunk-review-heartbeat\n\n";

/** The `event:` name one frame is sent under. */
export function reviewEventFrameName(type: ReviewEventTypeV1, phase?: ReviewEventFramePhase) {
  return phase === undefined ? type : `${type}-${phase}`;
}

/** Read one `event:` name back into the type and phase it was built from. */
export function parseReviewEventFrameName(
  name: string,
): { type: ReviewEventTypeV1; phase?: ReviewEventFramePhase } | undefined {
  for (const type of REVIEW_EVENT_TYPES) {
    if (name === type) {
      return { type };
    }
    for (const phase of REVIEW_EVENT_FRAME_PHASES) {
      if (name === reviewEventFrameName(type, phase)) {
        return { type, phase };
      }
    }
  }
  return undefined;
}

/**
 * Build the id one event is known by.
 *
 * An event is identified by what it is about — its type and the publication position it
 * describes — rather than by a counter, so two streams watching one session name the same
 * event the same way and a resuming client can tell whether it already has this one.
 */
export function reviewEventId(type: ReviewEventTypeV1, address: ReviewPublicationAddress) {
  return `revent:${type}:${address.generation}@${address.stateRevision}`;
}

/** Read one event id back into the type and position it names. */
export function parseReviewEventId(
  value: unknown,
): { type: ReviewEventTypeV1; address: ReviewPublicationAddress } | undefined {
  if (typeof value !== "string" || value.length > MAX_REVIEW_EVENT_ID_BYTES) {
    return undefined;
  }
  const match = /^revent:([a-z-]+):(.+)@(\d{1,15})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const type = REVIEW_EVENT_TYPES.find((candidate) => candidate === match[1]);
  const stateRevision = Number(match[3]);
  if (
    !type ||
    parseReviewGeneration(match[2]) === undefined ||
    !Number.isSafeInteger(stateRevision)
  ) {
    return undefined;
  }
  return { type, address: { generation: match[2]!, stateRevision } };
}

/** Whether one value could be an event id a client is echoing back at us. */
export function isReviewEventId(value: unknown): value is string {
  return parseReviewEventId(value) !== undefined;
}

// -- Frame payloads ---------------------------------------------------------------------

/** One whole event, small enough to send in a single frame. */
export interface ReviewEventFrameV1 {
  eventId: string;
  generation: string;
  stateRevision: number;
  payload: unknown;
}

/** What a chunked event declares before any of its bytes arrive. */
export interface ReviewEventBeginV1 {
  eventId: string;
  generation: string;
  stateRevision: number;
  encoding: "base64";
  contentSize: number;
  contentDigest: string;
  chunkCount: number;
}

/**
 * One slice of a chunked payload.
 *
 * Exactly a resource chunk with the event id in place of the resource id, because that is
 * exactly what it is: a bounded window of a measured, digested byte stream. Deriving the
 * type keeps the two from drifting and lets the shared assembler verify event payloads
 * without knowing they are events.
 */
export type ReviewEventChunkV1 = Omit<ReviewResourceChunkV1, "resourceId"> & { eventId: string };

/** What a chunked event repeats once its bytes have all been sent. */
export interface ReviewEventEndV1 {
  eventId: string;
  generation: string;
  contentSize: number;
  contentDigest: string;
  chunkCount: number;
}

/** View one event chunk as the resource chunk the shared assembler verifies. */
export function reviewEventChunkAsResourceChunk(chunk: ReviewEventChunkV1): ReviewResourceChunkV1 {
  const { eventId, ...rest } = chunk;
  return { resourceId: eventId, ...rest };
}

/** Whether one value is a plain object rather than an array or null. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whether one value is a non-negative safe integer. */
function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Whether one value states a payload size this stream is willing to carry. */
function isPayloadSize(value: unknown): value is number {
  return isCount(value) && (value as number) <= MAX_REVIEW_EVENT_PAYLOAD_BYTES;
}

/** Whether one value states a chunk count within the derived ceiling. */
function isChunkCount(value: unknown): value is number {
  return isCount(value) && (value as number) >= 1 && (value as number) <= MAX_REVIEW_EVENT_CHUNKS;
}

/** Parse one single-frame event body. */
export function parseReviewEventFrame(value: unknown): ReviewEventFrameV1 | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, ["eventId", "generation", "stateRevision", "payload"]) ||
    !isReviewEventId(record.eventId) ||
    parseReviewGeneration(record.generation) === undefined ||
    !isCount(record.stateRevision)
  ) {
    return undefined;
  }
  return record as unknown as ReviewEventFrameV1;
}

/** Parse one chunked-event begin envelope. */
export function parseReviewEventBegin(value: unknown): ReviewEventBeginV1 | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "eventId",
      "generation",
      "stateRevision",
      "encoding",
      "contentSize",
      "contentDigest",
      "chunkCount",
    ]) ||
    !isReviewEventId(record.eventId) ||
    parseReviewGeneration(record.generation) === undefined ||
    !isCount(record.stateRevision) ||
    record.encoding !== "base64" ||
    !isPayloadSize(record.contentSize) ||
    !isReviewSha256Digest(record.contentDigest) ||
    !isChunkCount(record.chunkCount)
  ) {
    return undefined;
  }
  return record as unknown as ReviewEventBeginV1;
}

/** Parse one chunk frame. Its bytes are decoded by the transport, as resource chunks are. */
export function parseReviewEventChunk(value: unknown): ReviewEventChunkV1 | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "eventId",
      "generation",
      "offset",
      "byteLength",
      "encoding",
      "data",
      "contentDigest",
      "contentSize",
      "eof",
    ]) ||
    !isReviewEventId(record.eventId) ||
    parseReviewGeneration(record.generation) === undefined ||
    !isCount(record.offset) ||
    !isCount(record.byteLength) ||
    (record.byteLength as number) > REVIEW_EVENT_CHUNK_BYTES ||
    record.encoding !== "base64" ||
    typeof record.data !== "string" ||
    !isReviewSha256Digest(record.contentDigest) ||
    !isPayloadSize(record.contentSize) ||
    typeof record.eof !== "boolean"
  ) {
    return undefined;
  }
  return record as unknown as ReviewEventChunkV1;
}

/** Parse one chunked-event end envelope. */
export function parseReviewEventEnd(value: unknown): ReviewEventEndV1 | undefined {
  const record = asRecord(value);
  if (
    !record ||
    !hasExactKeys(record, [
      "eventId",
      "generation",
      "contentSize",
      "contentDigest",
      "chunkCount",
    ]) ||
    !isReviewEventId(record.eventId) ||
    parseReviewGeneration(record.generation) === undefined ||
    !isPayloadSize(record.contentSize) ||
    !isReviewSha256Digest(record.contentDigest) ||
    !isChunkCount(record.chunkCount)
  ) {
    return undefined;
  }
  return record as unknown as ReviewEventEndV1;
}

// -- Framing ----------------------------------------------------------------------------

/** One SSE frame, before it is turned into text. */
export interface ReviewEventSseFrame {
  /** Present only on a frame that completes an event, so a resume never lands mid-payload. */
  id?: string;
  event: string;
  data: unknown;
}

/**
 * Render one frame as SSE text.
 *
 * `JSON.stringify` guarantees the single-line `data:` this format requires — every newline
 * inside a payload is escaped — so no frame can be split by its own contents.
 */
export function encodeReviewEventFrame(frame: ReviewEventSseFrame): string {
  return `${frame.id ? `id: ${frame.id}\n` : ""}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** How many chunks one payload of the given size is sent as. */
export function reviewEventChunkCount(contentSize: number) {
  return Math.max(1, Math.ceil(contentSize / REVIEW_EVENT_CHUNK_BYTES));
}

export interface PlanReviewEventInput {
  type: ReviewEventTypeV1;
  address: ReviewPublicationAddress;
  /** The event body itself, sent as-is when it fits one frame. */
  body: unknown;
  /** The same body serialized, which is what a chunked event actually carries. */
  payload: Uint8Array;
  /** Digest of the whole payload, computed by whichever tier owns bytes. */
  contentDigest: string;
  /** Base64 of one payload window; the codec is the transport's, as it is for resources. */
  encodeChunk: (bytes: Uint8Array) => string;
  /** Smaller chunking for tests; never larger than the shared bound. */
  chunkBytes?: number;
}

/** Raised when an event would exceed a bound both ends of this protocol agree on. */
export class ReviewEventTooLargeError extends Error {
  override readonly name = "ReviewEventTooLargeError";
}

/**
 * Frame one event for the wire.
 *
 * A payload that fits one chunk is one frame carrying the parsed body; anything larger is
 * begin, chunks, end. Callers hand in serialized bytes and a digest because computing
 * either needs a platform, and this module may not have one.
 */
export function planReviewEventFrames(input: PlanReviewEventInput): ReviewEventSseFrame[] {
  const { type, address, payload, contentDigest } = input;
  const contentSize = payload.byteLength;
  if (contentSize > MAX_REVIEW_EVENT_PAYLOAD_BYTES) {
    throw new ReviewEventTooLargeError(
      `Review event payload of ${contentSize} bytes exceeds the ${MAX_REVIEW_EVENT_PAYLOAD_BYTES}-byte stream bound.`,
    );
  }
  // Held between the shared window size and whatever the payload needs to fit the derived
  // chunk ceiling, so a sender asking for smaller frames can never emit more chunks than a
  // reader's bound admits — the coincidental-compatibility failure C4 is about.
  const chunkBytes = Math.max(
    Math.min(input.chunkBytes ?? REVIEW_EVENT_CHUNK_BYTES, REVIEW_EVENT_CHUNK_BYTES),
    Math.ceil(contentSize / MAX_REVIEW_EVENT_CHUNKS),
  );
  const eventId = reviewEventId(type, address);

  if (contentSize <= chunkBytes) {
    return [
      {
        id: eventId,
        event: reviewEventFrameName(type),
        data: {
          eventId,
          generation: address.generation,
          stateRevision: address.stateRevision,
          // The single-frame form carries the body itself; there is nothing to reassemble,
          // so re-encoding it as base64 would only cost a client a decode.
          payload: input.body,
        } satisfies ReviewEventFrameV1,
      },
    ];
  }

  const chunkCount = Math.ceil(contentSize / chunkBytes);
  const frames: ReviewEventSseFrame[] = [
    {
      event: reviewEventFrameName(type, "begin"),
      data: {
        eventId,
        generation: address.generation,
        stateRevision: address.stateRevision,
        encoding: "base64",
        contentSize,
        contentDigest,
        chunkCount,
      } satisfies ReviewEventBeginV1,
    },
  ];
  for (let index = 0; index < chunkCount; index += 1) {
    const offset = index * chunkBytes;
    const slice = payload.subarray(offset, Math.min(offset + chunkBytes, contentSize));
    frames.push({
      event: reviewEventFrameName(type, "chunk"),
      data: {
        eventId,
        generation: address.generation,
        offset,
        byteLength: slice.byteLength,
        encoding: "base64",
        data: input.encodeChunk(slice),
        contentDigest,
        contentSize,
        eof: index === chunkCount - 1,
      } satisfies ReviewEventChunkV1,
    });
  }
  frames.push({
    id: eventId,
    event: reviewEventFrameName(type, "end"),
    data: {
      eventId,
      generation: address.generation,
      contentSize,
      contentDigest,
      chunkCount,
    } satisfies ReviewEventEndV1,
  });
  return frames;
}

// -- Reading ----------------------------------------------------------------------------

export interface ReviewEventAssemblerOptions {
  begin: ReviewEventBeginV1;
  /** Platform hashing, injected exactly as the resource assembler takes it. */
  digest: ReviewDigestFn;
}

/**
 * Reassemble one chunked event payload.
 *
 * A thin shell over `ReviewChunkAssembler`: the chunk rules — offsets that must meet, a
 * size and digest that may not change mid-stream, progress that must be real, bytes that
 * must hash to what was declared — are that class's, not a second copy of them
 * (`docs/browser-review-seam-audit.md`, C2). What this adds is the event's own framing
 * rules: chunks belong to the event that began, and the count the end frame reports must
 * be the count that arrived.
 */
export class ReviewEventAssembler {
  private readonly assembler: ReviewChunkAssembler;
  private readonly begin: ReviewEventBeginV1;
  private accepted = 0;

  constructor({ begin, digest }: ReviewEventAssemblerOptions) {
    this.begin = begin;
    this.assembler = new ReviewChunkAssembler({
      resourceId: begin.eventId,
      generation: begin.generation,
      digest,
      maxBytes: MAX_REVIEW_EVENT_PAYLOAD_BYTES,
      expected: { byteLength: begin.contentSize, digest: begin.contentDigest },
    });
  }

  /** How many chunks have been taken so far, for the end frame to be checked against. */
  get chunkCount() {
    return this.accepted;
  }

  /** Accept one chunk and its decoded bytes. */
  accept(chunk: ReviewEventChunkV1, bytes: Uint8Array) {
    if (chunk.eventId !== this.begin.eventId) {
      return {
        ok: false as const,
        code: "resource-integrity" as const,
        message: `Review event ${this.begin.eventId} received a chunk for ${chunk.eventId}.`,
      };
    }
    if (this.accepted >= this.begin.chunkCount) {
      return {
        ok: false as const,
        code: "resource-integrity" as const,
        message: `Review event ${this.begin.eventId} sent more than the ${this.begin.chunkCount} chunks it declared.`,
      };
    }
    const step = this.assembler.accept({ chunk: reviewEventChunkAsResourceChunk(chunk), bytes });
    if (step.ok) {
      this.accepted += 1;
    }
    return step;
  }

  /** Verify the assembled payload against the event's declared end. */
  finish(end: ReviewEventEndV1): ReviewAssemblyResult {
    if (
      end.eventId !== this.begin.eventId ||
      end.contentSize !== this.begin.contentSize ||
      end.contentDigest !== this.begin.contentDigest ||
      end.chunkCount !== this.begin.chunkCount ||
      end.chunkCount !== this.accepted
    ) {
      return {
        ok: false,
        code: "resource-integrity",
        message: `Review event ${this.begin.eventId} ended with a declaration it did not begin with.`,
      };
    }
    return this.assembler.finish();
  }
}
