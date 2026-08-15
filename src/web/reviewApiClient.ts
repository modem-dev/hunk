/**
 * Talking to one live review over the daemon's HTTP surface.
 *
 * Four things a browser client needs: read where the review is, read the content behind
 * it, watch it move, and be told why a request was refused. Every rule about how those
 * happen already exists — routes and authorization in `reviewHttpProtocol`, frame names and
 * envelopes in `reviewEventProtocol`, chunk verification in the shared
 * `ReviewChunkAssembler`, wording in `reviewErrorCatalog` — so this module composes them
 * and owns only what a transport owns: requests, ranges, streams, and abort.
 *
 * That is the whole point of the C4/C2/G4 findings. The prototype's client re-declared the
 * server's frame names, regex-parsed its event ids, wrote its own range loop with its own
 * digest handling, and invented its own wording for failures
 * (`docs/browser-review-seam-audit.md`). Nothing here declares any of that; the boundary
 * gate in `scripts/source-boundaries.test.ts` keeps it that way by restricting what this
 * tree may import at all.
 *
 * Two transport decisions worth stating:
 *
 * - **The stream is read with `fetch`, not `EventSource`.** The capability is presented in
 *   a request header and `EventSource` cannot set one. That also removes the built-in
 *   reconnect an `EventSource` would bring, so reconnect timing is the caller's, through
 *   the one shared scheduler (C5).
 * - **A resource is read in windows and verified as one stream.** The surface caps every
 *   response at the shared chunk size, so a read is several requests; each response states
 *   the whole resource's size and digest, and the shared assembler holds every window to
 *   the first one's declaration and hashes the result.
 */
import {
  REVIEW_RESOURCE_CHUNK_BYTES,
  reviewResourceCeiling,
  type ReviewResourceDescriptorV1,
} from "../core/review/resources";
import { ReviewChunkAssembler } from "../core/review/resourceAssembly";
import type { ReviewDigestFn } from "../core/review/validation";
import { reviewErrorMessage } from "../session/reviewErrorCatalog";
import {
  parseReviewEventBegin,
  parseReviewEventChunk,
  parseReviewEventEnd,
  parseReviewEventFrame,
  parseReviewEventFrameName,
  REVIEW_EVENT_STREAM_CONTENT_TYPE,
  ReviewEventAssembler,
  ReviewEventSseDecoder,
  type ReviewEventSseRecord,
  type ReviewEventTypeV1,
} from "../session/reviewEventProtocol";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  parseReviewContentMeasurementHeaders,
  parseReviewCapabilityFragment,
  reviewErrorCodeForStatus,
  reviewHttpFailure,
  reviewHttpPath,
  reviewPagePath,
  type HunkReviewClientErrorCodeV1,
  type HunkReviewHttpFailureV1,
  type HunkReviewHttpRoute,
  type HunkReviewPublicationBodyV1,
} from "../session/reviewHttpProtocol";
import {
  HUNK_REVIEW_PROTOCOL_VERSION,
  parseHunkReviewPublicationAddress,
  parseHunkReviewResourceCatalog,
} from "../session/reviewProtocol";
import { webReviewDigest } from "./reviewDigest";

/**
 * One refusal, exactly as the surface answers it.
 *
 * The wire type itself rather than a client-side restatement of its fields: a refusal this
 * client reports is one the review surface either sent or would have sent, so there is no
 * second shape to keep in step (G4). `reviewHttpFailure` builds them, on both ends.
 */
export type ReviewClientFailure = HunkReviewHttpFailureV1;

export type ReviewClientResult<Value> = { ok: true; value: Value } | ReviewClientFailure;

/**
 * The catalog's sentence for one code, with what this client can add about this instance.
 *
 * The catalog states what happened and what to do about it; a client knows which read or
 * which frame it was. Appending rather than replacing is what keeps the browser and the
 * terminal explaining the same failure the same way (G4).
 */
function withDetail(code: HunkReviewClientErrorCodeV1, detail: string) {
  return detail ? `${reviewErrorMessage(code)} (${detail})` : reviewErrorMessage(code);
}

/** What the client was told, or the fact that it could not be told anything. */
function transportFailure(error: unknown): ReviewClientFailure {
  return reviewHttpFailure("resource-unavailable", {
    message: withDetail("resource-unavailable", error instanceof Error ? error.message : ""),
  });
}

/** Where this client is talking, and who it says it is. */
export interface ReviewApiClientOptions {
  /** Origin the review surface is served from, e.g. `http://127.0.0.1:4300`. */
  origin: string;
  sessionId: string;
  /** The capability read from the review URL's fragment. */
  capability: string;
  /** Injected so a test can drive a real server without a global. */
  fetch?: typeof globalThis.fetch;
  /** Injected so the same client can be exercised against the session's own hashing. */
  digest?: ReviewDigestFn;
}

/** What one review event stream reports to whoever opened it. */
export interface ReviewEventHandlers {
  /** The review's current position and catalog, complete every time. */
  onPublication: (body: HunkReviewPublicationBodyV1) => void;
  /** The session behind the stream is gone; no further event is coming. */
  onDisconnect?: () => void;
  /** The stream ended or could not be read. Reconnecting is the caller's decision. */
  onError?: (failure: ReviewClientFailure) => void;
}

/**
 * Read one review URL into the client that talks to it.
 *
 * The session id comes from the path and the capability from the fragment, both through
 * the shared grammar, so a URL this cannot read is one the session never wrote.
 */
export function parseReviewLocation(
  location: Pick<URL, "origin" | "pathname" | "hash">,
): { origin: string; sessionId: string; capability: string } | undefined {
  const capability = parseReviewCapabilityFragment(location.hash);
  if (!capability) {
    return undefined;
  }
  // Recognized by rebuilding the page path from each candidate segment rather than by
  // matching a pattern this module would then own a second copy of. A segment whose
  // percent-encoding does not decode is not a candidate rather than an error: this
  // function answers "is this a review URL?", and a malformed one is not.
  const segments = location.pathname.split("/").filter((segment) => segment.length > 0);
  const sessionId = segments
    .flatMap((segment) => {
      try {
        return [decodeURIComponent(segment)];
      } catch {
        return [];
      }
    })
    .find((candidate) => location.pathname.startsWith(reviewPagePath(candidate)));
  return sessionId ? { origin: location.origin, sessionId, capability } : undefined;
}

export class ReviewApiClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly digest: ReviewDigestFn;

  constructor(private readonly options: ReviewApiClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.digest = options.digest ?? webReviewDigest;
  }

  get sessionId() {
    return this.options.sessionId;
  }

  /**
   * Read where the review is and what it offers there.
   *
   * The body is parsed through the wire protocol's own parsers rather than cast, so a
   * publication this client accepts is one the daemon would also have accepted — the
   * catalog especially, since every later read is addressed from it.
   */
  async readPublication(
    signal?: AbortSignal,
  ): Promise<ReviewClientResult<HunkReviewPublicationBodyV1>> {
    let response: Response;
    try {
      response = await this.request({ kind: "publication", sessionId: this.sessionId }, { signal });
    } catch (error) {
      return transportFailure(error);
    }
    if (!response.ok) {
      return this.readFailure(response);
    }
    return this.parsePublication(await response.json().catch(() => undefined));
  }

  /**
   * Read one whole resource, verified against the measurement it is served with.
   *
   * Windows are requested at the shared chunk size and handed to the shared assembler,
   * which is what refuses a stream that overlaps, skips, changes its declared size, or
   * ends at a digest other than the one it opened with.
   */
  async readResource(
    descriptor: Pick<ReviewResourceDescriptorV1, "id" | "generation" | "kind">,
    signal?: AbortSignal,
  ): Promise<ReviewClientResult<Uint8Array>> {
    const assembler = new ReviewChunkAssembler({
      resourceId: descriptor.id,
      generation: descriptor.generation,
      digest: this.digest,
      maxBytes: reviewResourceCeiling(descriptor.kind),
    });

    for (;;) {
      const window = await this.readResourceWindow(descriptor, assembler.nextOffset, signal);
      if (!window.ok) {
        return window;
      }
      const { bytes, measurement } = window.value;
      const step = assembler.accept({
        chunk: {
          generation: descriptor.generation,
          resourceId: descriptor.id,
          offset: assembler.nextOffset,
          byteLength: bytes.byteLength,
          // The record describes the window; the bytes ride in the response body rather
          // than inside it, so the assembler is handed them decoded and `data` is empty.
          encoding: "base64",
          data: "",
          contentDigest: measurement.digest,
          contentSize: measurement.byteLength,
          // HTTP has no end-of-stream marker of its own: a window ends the resource when
          // it reaches the size every response states. The assembler still checks that
          // claim against what it actually received.
          eof: assembler.nextOffset + bytes.byteLength >= measurement.byteLength,
        },
        bytes,
      });
      if (!step.ok) {
        return reviewHttpFailure(step.code, { message: step.message });
      }
      if (step.done) {
        break;
      }
    }

    const assembled = assembler.finish();
    return assembled.ok
      ? { ok: true, value: assembled.bytes }
      : reviewHttpFailure(assembled.code, { message: assembled.message });
  }

  /**
   * Follow one review's event stream until it ends or the caller aborts.
   *
   * Resolves when the stream is over — normally, because the session disconnected or the
   * caller aborted, or because reading failed. Whether and when to open another one is the
   * caller's, which is what keeps reconnect policy in one place instead of two.
   */
  async streamEvents(handlers: ReviewEventHandlers, signal?: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.request(
        { kind: "events", sessionId: this.sessionId },
        { signal, headers: { accept: REVIEW_EVENT_STREAM_CONTENT_TYPE } },
      );
    } catch (error) {
      handlers.onError?.(transportFailure(error));
      return;
    }
    if (!response.ok || !response.body) {
      handlers.onError?.(await this.readFailure(response));
      return;
    }

    const reader = new ReviewEventStreamReader(this.digest, handlers);
    try {
      await readServerSentRecords(response.body, (record) => reader.accept(record));
      reader.finishStream();
    } catch (error) {
      // An abort is the caller ending the stream, not a failure to report.
      if (!signal?.aborted) {
        handlers.onError?.(transportFailure(error));
      }
    }
  }

  /** Narrow one publication body, refusing anything the wire protocol would not carry. */
  private parsePublication(value: unknown): ReviewClientResult<HunkReviewPublicationBodyV1> {
    const record =
      value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    const publication = parseHunkReviewPublicationAddress(record?.publication);
    const catalog = parseHunkReviewResourceCatalog(record?.catalog);
    if (
      !record ||
      record.protocolVersion !== HUNK_REVIEW_PROTOCOL_VERSION ||
      record.sessionId !== this.sessionId ||
      !publication ||
      !catalog ||
      catalog.generation !== publication.generation
    ) {
      return reviewHttpFailure("invalid-request");
    }
    return {
      ok: true,
      value: {
        protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
        sessionId: this.sessionId,
        publication,
        catalog,
      },
    };
  }

  /** Fetch one window of one resource, with the measurement the response states. */
  private async readResourceWindow(
    descriptor: Pick<ReviewResourceDescriptorV1, "id" | "generation">,
    offset: number,
    signal: AbortSignal | undefined,
  ): Promise<
    ReviewClientResult<{ bytes: Uint8Array; measurement: { byteLength: number; digest: string } }>
  > {
    let response: Response;
    try {
      response = await this.request(
        {
          kind: "resource",
          sessionId: this.sessionId,
          generation: descriptor.generation,
          resourceId: descriptor.id,
        },
        {
          signal,
          // The first window asks for no range at all: the surface caps every response at
          // the shared chunk size anyway, and a zero-length resource has no satisfiable
          // range, so asking for one would refuse a resource that is merely empty.
          ...(offset === 0
            ? {}
            : {
                headers: {
                  range: `bytes=${offset}-${offset + REVIEW_RESOURCE_CHUNK_BYTES - 1}`,
                },
              }),
        },
      );
    } catch (error) {
      return transportFailure(error);
    }
    if (!response.ok) {
      return this.readFailure(response);
    }

    const measurement = parseReviewContentMeasurementHeaders(response.headers);
    if (!measurement) {
      // Without a measurement there is nothing to verify against, and serving bytes that
      // cannot be checked is worse than refusing them.
      return reviewHttpFailure("resource-integrity");
    }
    return {
      ok: true,
      value: { bytes: new Uint8Array(await response.arrayBuffer()), measurement },
    };
  }

  /** One request to one route, carrying the capability and nothing else identifying. */
  private request(
    route: HunkReviewHttpRoute,
    init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  ) {
    return this.fetch(`${this.options.origin}${reviewHttpPath(route)}`, {
      headers: {
        [HUNK_REVIEW_CAPABILITY_HEADER]: this.options.capability,
        ...init.headers,
      },
      ...(init.signal ? { signal: init.signal } : {}),
    });
  }

  /**
   * Read one refusal out of a response.
   *
   * The surface answers failures in one shape with a code from the shared vocabulary; a
   * response that is not in that shape is reported by its status rather than guessed at,
   * because a body this client cannot read is not one it should quote.
   */
  private async readFailure(response: Response): Promise<ReviewClientFailure> {
    const body = (await response.json().catch(() => undefined)) as
      | Partial<ReviewClientFailure>
      | undefined;
    if (body?.ok === false && typeof body.code === "string") {
      return reviewHttpFailure(body.code, {
        ...(typeof body.message === "string" ? { message: body.message } : {}),
        ...(typeof body.currentGeneration === "string"
          ? { currentGeneration: body.currentGeneration }
          : {}),
      });
    }
    // One route answers without a body: an unsatisfiable range is refused with a bare
    // 416 and a `content-range` stating the size that should have been asked within. The
    // status is read through the shared table, so this client holds no opinion about
    // which code a status means; a status several codes share is not guessed at.
    return reviewHttpFailure(reviewErrorCodeForStatus(response.status) ?? "invalid-request");
  }
}

/**
 * Read one byte stream as the records the review event protocol wrote.
 *
 * The record grammar itself is the protocol's, beside the writer that produces it; what
 * this adds is the browser's half — decoding bytes to text and releasing the reader when
 * the caller is done with the stream.
 */
async function readServerSentRecords(
  body: ReadableStream<Uint8Array>,
  onRecord: (record: ReviewEventSseRecord) => void,
) {
  const reader = body.getReader();
  const textDecoder = new TextDecoder();
  const records = new ReviewEventSseDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      for (const record of records.push(textDecoder.decode(value, { stream: true }))) {
        onRecord(record);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Turn a stream of records into the events they describe.
 *
 * Frame names, envelopes, and payload reassembly are all the shared protocol's — this
 * holds the little state a reader needs between frames: which chunked event is open, and
 * what to do when one completes.
 */
class ReviewEventStreamReader {
  private assembler: ReviewEventAssembler | undefined;
  private assemblingType: ReviewEventTypeV1 | undefined;
  private disconnected = false;

  constructor(
    private readonly digest: ReviewDigestFn,
    private readonly handlers: ReviewEventHandlers,
  ) {}

  /** Take one record, dispatching whatever it completes. */
  accept(record: ReviewEventSseRecord) {
    const frame = parseReviewEventFrameName(record.event);
    if (!frame) {
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(record.data);
    } catch {
      this.fail("a review event arrived that could not be read");
      return;
    }

    if (frame.phase === undefined) {
      const parsed = parseReviewEventFrame(data);
      if (!parsed) {
        this.fail("a review event arrived in a shape this client does not accept");
        return;
      }
      this.dispatch(frame.type, parsed.payload);
      return;
    }
    if (frame.phase === "begin") {
      const begin = parseReviewEventBegin(data);
      if (!begin) {
        this.fail("a chunked review event began in a shape this client does not accept");
        return;
      }
      this.assembler = new ReviewEventAssembler({ begin, digest: this.digest });
      this.assemblingType = frame.type;
      return;
    }
    if (frame.phase === "chunk") {
      const chunk = parseReviewEventChunk(data);
      if (!chunk || !this.assembler) {
        this.fail("a review event chunk arrived without a payload to belong to");
        return;
      }
      const step = this.assembler.accept(chunk, decodeBase64(chunk.data));
      if (!step.ok) {
        this.fail(step.message);
      }
      return;
    }

    const end = parseReviewEventEnd(data);
    if (!end || !this.assembler || this.assemblingType !== frame.type) {
      this.fail("a review event ended without a payload to complete");
      return;
    }
    const assembled = this.assembler.finish(end);
    this.assembler = undefined;
    if (!assembled.ok) {
      this.fail(assembled.message);
      return;
    }
    try {
      this.dispatch(frame.type, JSON.parse(new TextDecoder().decode(assembled.bytes)));
    } catch {
      this.fail("a review event carried a payload that could not be read");
    }
  }

  /** Report a stream that ended without the session saying goodbye. */
  finishStream() {
    if (!this.disconnected) {
      this.handlers.onError?.(
        reviewHttpFailure("resource-unavailable", {
          message: withDetail("resource-unavailable", "the review event stream ended"),
        }),
      );
    }
  }

  /** Hand one completed event to the caller. */
  private dispatch(type: ReviewEventTypeV1, payload: unknown) {
    if (type === "disconnect") {
      this.disconnected = true;
      this.handlers.onDisconnect?.();
      return;
    }
    // The stream carries no deltas: every publication is complete, so a client applies it
    // whole rather than reconciling it against what it already had.
    this.handlers.onPublication(payload as HunkReviewPublicationBodyV1);
  }

  private fail(detail: string) {
    this.assembler = undefined;
    this.handlers.onError?.(
      reviewHttpFailure("resource-integrity", {
        message: withDetail("resource-integrity", detail),
      }),
    );
  }
}

/** Decode one base64 chunk with the browser's own decoder. */
function decodeBase64(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
