/**
 * Reading one resource back: the reader's half of the addressing model in `resources.ts`.
 *
 * A resource arrives as a sequence of bounded chunks, and every chunk repeats the same
 * three facts about the whole resource — its size, its digest, and where this slice sits
 * in it. Assembling them means checking that those facts never change, that each chunk
 * lands exactly where the last one ended, that progress is real, and that the bytes the
 * reader ends up with hash to what the writer declared.
 *
 * The prototype wrote that loop four times, twice inside one file, and the copies already
 * disagreed about the end-of-stream and progress rules
 * (`docs/browser-review-seam-audit.md`, C2). It is written once here, in the shared model,
 * so a broker reading over a websocket and a browser reading over HTTP verify the same
 * way. What stays at the edges is transport and platform: acquiring chunks, decoding
 * base64, and hashing — the last of which arrives as an injected `ReviewDigestFn` because
 * core may not reach for a hashing runtime.
 */
import {
  REVIEW_RESOURCE_CHUNK_BYTES,
  reviewResourceFailure,
  type ReviewResourceChunkV1,
  type ReviewResourceErrorCode,
  type ReviewResourceFailure,
} from "./resources";
import { isReviewSha256Digest, reviewDigestsEqual, type ReviewDigestFn } from "./validation";

/** A refused assembly, in the shared resource vocabulary a caller already handles. */
export type ReviewAssemblyFailure = ReviewResourceFailure;

export type ReviewAssemblyStep = { ok: true; done: boolean } | ReviewAssemblyFailure;

export type ReviewAssemblyResult = { ok: true; bytes: Uint8Array } | ReviewAssemblyFailure;

/** One chunk plus the bytes a transport decoded from it. */
export interface ReviewResourceChunkBytes {
  chunk: ReviewResourceChunkV1;
  bytes: Uint8Array;
}

/**
 * What one assembler needs to verify a read it did not perform.
 *
 * Everything platform-shaped enters here rather than being reached for, which is why
 * hashing is the injected `ReviewDigestFn` seam below.
 */
export interface ReviewChunkAssemblerOptions {
  /** The resource being read; a chunk about anything else is a routing failure. */
  resourceId: string;
  /** The generation the read was issued against. */
  generation: string;
  /** Platform hashing, injected so core never depends on one. */
  digest: ReviewDigestFn;
  /**
   * Largest resource this reader will hold.
   *
   * Declared by the caller because the bound differs by kind — a full source text is held
   * to a much smaller limit than a canonical file — and enforced against the size the
   * writer declares, before any bytes are retained.
   */
  maxBytes: number;
  /**
   * Size and digest already known from a descriptor, when the reader has one.
   *
   * A read against a measured descriptor must produce exactly that resource; a read whose
   * descriptor was not yet materialized adopts the first chunk's declaration and holds
   * every later chunk to it.
   */
  expected?: { byteLength: number; digest: string };
}

/**
 * Assemble one resource from bounded chunks, verifying as it goes.
 *
 * The assembler is single-use and stateful: feed it chunks in order until a step reports
 * `done`, then `finish()`. Every rejection carries a resource error code, so a caller
 * distinguishes a corrupt stream (`resource-integrity`) from a mis-addressed one
 * (`invalid-range`) from one that is simply too big (`resource-too-large`) — the
 * distinction the prototype lost by throwing plain strings.
 */
export class ReviewChunkAssembler {
  private readonly options: ReviewChunkAssemblerOptions;
  private buffer: Uint8Array | undefined;
  private offset = 0;
  private contentSize: number | undefined;
  private contentDigest: string | undefined;
  private complete = false;
  private failed: ReviewAssemblyFailure | undefined;

  constructor(options: ReviewChunkAssemblerOptions) {
    this.options = options;
    if (options.expected) {
      this.contentSize = options.expected.byteLength;
      this.contentDigest = options.expected.digest;
    }
  }

  /** Where the next chunk must start. */
  get nextOffset() {
    return this.offset;
  }

  /** How many bytes are still outstanding, once the writer has declared a total. */
  get remainingBytes() {
    return this.contentSize === undefined ? undefined : this.contentSize - this.offset;
  }

  /** The whole-resource size the writer declared, once any chunk has declared one. */
  get declaredSize() {
    return this.contentSize;
  }

  /**
   * Accept one chunk.
   *
   * Reports `done: true` when the writer marked end of stream; a caller must stop reading
   * then rather than deciding for itself, because a zero-length resource is one empty
   * chunk with `eof` set and has no other terminator.
   */
  accept({ chunk, bytes }: ReviewResourceChunkBytes): ReviewAssemblyStep {
    if (this.failed) {
      return this.failed;
    }
    if (this.complete) {
      return this.fail(
        "resource-integrity",
        `Review resource ${this.options.resourceId} received a chunk after end of stream.`,
      );
    }

    if (
      chunk.resourceId !== this.options.resourceId ||
      chunk.generation !== this.options.generation
    ) {
      return this.fail(
        "resource-integrity",
        `Review resource ${this.options.resourceId} received a chunk for ${chunk.resourceId} in ${chunk.generation}.`,
      );
    }
    if (chunk.encoding !== "base64") {
      return this.fail(
        "resource-integrity",
        `Review resource ${this.options.resourceId} declared an unsupported chunk encoding.`,
      );
    }
    if (chunk.offset !== this.offset || chunk.byteLength !== bytes.byteLength) {
      return this.fail(
        "invalid-range",
        `Review resource ${this.options.resourceId} returned ${chunk.byteLength} bytes at ${chunk.offset}; ${this.offset} was expected next.`,
      );
    }
    if (bytes.byteLength > REVIEW_RESOURCE_CHUNK_BYTES) {
      return this.fail(
        "invalid-range",
        `Review resource ${this.options.resourceId} returned a chunk over the ${REVIEW_RESOURCE_CHUNK_BYTES}-byte bound.`,
      );
    }

    // Size and digest are declared by every chunk and may never change mid-stream; the
    // first one to arrive fixes them when no descriptor already had.
    if (!Number.isSafeInteger(chunk.contentSize) || chunk.contentSize < 0) {
      return this.fail(
        "resource-integrity",
        `Review resource ${this.options.resourceId} declared an unusable content size.`,
      );
    }
    if (!isReviewSha256Digest(chunk.contentDigest)) {
      return this.fail(
        "resource-integrity",
        `Review resource ${this.options.resourceId} declared a digest outside the canonical form.`,
      );
    }
    if (this.contentSize === undefined) {
      this.contentSize = chunk.contentSize;
      this.contentDigest = chunk.contentDigest;
    } else if (
      this.contentSize !== chunk.contentSize ||
      !reviewDigestsEqual(this.contentDigest!, chunk.contentDigest)
    ) {
      return this.fail(
        "resource-integrity",
        `Review resource ${this.options.resourceId} changed its declared size or digest mid-stream.`,
      );
    }
    if (this.contentSize > this.options.maxBytes) {
      return this.fail(
        "resource-too-large",
        `Review resource ${this.options.resourceId} declares ${this.contentSize} bytes, over the ${this.options.maxBytes}-byte limit for its kind.`,
      );
    }
    if (this.offset + bytes.byteLength > this.contentSize) {
      return this.fail(
        "invalid-range",
        `Review resource ${this.options.resourceId} returned more bytes than the ${this.contentSize} it declares.`,
      );
    }
    // A chunk that neither advances nor ends the stream would loop a reader forever. The
    // one legal empty chunk is the end of a zero-length resource, which `eof` marks.
    if (bytes.byteLength === 0 && !chunk.eof) {
      return this.fail(
        "resource-integrity",
        `Review resource ${this.options.resourceId} made no progress and did not end.`,
      );
    }

    // Chunks land directly in the one final-size buffer, allocated only after the size
    // checks above accept the declared total. Peak memory therefore stays at the declared
    // size plus one in-flight chunk — never a second full copy at finish time.
    this.buffer ??= new Uint8Array(this.contentSize);
    this.buffer.set(bytes, this.offset);
    this.offset += bytes.byteLength;
    if (chunk.eof) {
      if (this.offset !== this.contentSize) {
        return this.fail(
          "resource-integrity",
          `Review resource ${this.options.resourceId} ended at ${this.offset} of ${this.contentSize} bytes.`,
        );
      }
      this.complete = true;
    }
    return { ok: true, done: this.complete };
  }

  /**
   * Verify everything accepted so far and hand back the assembled bytes.
   *
   * The digest is recomputed over the assembled bytes rather than trusted from the
   * stream, which is the whole point of carrying a whole-resource digest on every chunk.
   */
  finish(): ReviewAssemblyResult {
    if (this.failed) {
      return this.failed;
    }
    if (!this.complete || this.contentSize === undefined || this.contentDigest === undefined) {
      return this.fail(
        "resource-integrity",
        `Review resource ${this.options.resourceId} was assembled before its stream ended.`,
      );
    }

    const bytes = this.buffer ?? new Uint8Array(0);
    if (!reviewDigestsEqual(this.options.digest(bytes), this.contentDigest)) {
      return this.fail(
        "resource-integrity",
        `Review resource ${this.options.resourceId} does not hash to the digest it was served with.`,
      );
    }
    return { ok: true, bytes };
  }

  /** Record one failure so every later call reports the first cause rather than a symptom. */
  private fail(code: ReviewResourceErrorCode, message: string): ReviewAssemblyFailure {
    this.failed ??= reviewResourceFailure(code, message);
    return this.failed;
  }
}
