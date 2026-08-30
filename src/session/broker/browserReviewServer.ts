/**
 * Serving one live session's review over HTTP, from the daemon that already brokers it.
 *
 * The daemon holds a mirror of every session's review publication and a bounded, verified
 * path to the content behind it. This adds the four things a local client needs to use
 * that: read where the review is, read its content, watch it change, and act on it. It
 * runs inside the single loopback daemon rather than opening a port per terminal, so one
 * process is bound, one origin is trusted, and one lifecycle governs every attached
 * review.
 *
 * The surface is transport and authorization, nothing else. Every semantic question —
 * whether a file exists, which hunk owns a note, whether an action may be applied at this
 * position — is answered where it is already answered: by `planReviewIntent` at the
 * producer, reached through the existing `apply_review_action` path. Every ordering
 * question is `classifyReviewPublication`, reached through the mirror. This module decides
 * status codes and byte windows.
 *
 * Authorization is a capability, and the shape of it is deliberate:
 *
 * - The session mints it and publishes only its digest, so the daemon can verify a
 *   presented capability and can never produce one.
 * - It travels in the URL fragment and is presented in a request header, so it appears in
 *   no path, no query string, and no log, and cannot ride along on a cross-origin request
 *   the way a cookie would. That is also why this surface sends no CORS headers at all:
 *   there is no cross-origin use to allow.
 * - Comparison is constant-time over fixed-width digests, and an unknown session is
 *   compared against random bytes rather than short-circuited, so timing does not reveal
 *   which sessions exist.
 *
 * The event contract is `reviewEventProtocol.ts` and is not restated here — frame names,
 * envelopes, ids, and byte bounds all come from that module, which the browser client will
 * import unchanged. Declaring them independently on each end is exactly the defect this
 * phase repays (`docs/browser-review-seam-audit.md`, C4).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  MAX_HTTP_BODY_BYTES,
  PayloadTooLargeError,
  readRequestTextWithLimit,
} from "@hunk/session-broker-core";
import { nodeReviewDigest } from "../../core/reviewDigest";
import { REVIEW_RESOURCE_CHUNK_BYTES } from "../../core/review/resources";
import type { ReviewPublicationAddress } from "../../core/review/generationOrder";
import { isReviewSha256Digest } from "../../core/review/validation";
import { reviewErrorMessage } from "../reviewErrorCatalog";
import {
  encodeReviewEventFrame,
  planReviewEventFrames,
  REVIEW_EVENT_CHUNK_BYTES,
  REVIEW_EVENT_HEARTBEAT_FRAME,
  REVIEW_EVENT_STREAM_CONTENT_TYPE,
  ReviewEventTooLargeError,
  type ReviewEventTypeV1,
} from "../reviewEventProtocol";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  HUNK_REVIEW_HTTP_PATH_PREFIX,
  isReviewCapabilityToken,
  parseReviewHttpPath,
  type HunkReviewClientErrorCodeV1,
  type HunkReviewHttpFailureV1,
  type HunkReviewHttpRoute,
  type HunkReviewPublicationBodyV1,
} from "../reviewHttpProtocol";
import {
  HUNK_REVIEW_PROTOCOL_VERSION,
  MAX_HUNK_REVIEW_ENVELOPE_BYTES,
  parseHunkReviewActionEnvelope,
} from "../reviewProtocol";
import { allowsUnsafeRemoteSessionBroker, isLoopbackHost } from "./brokerConfig";
import {
  ReviewGenerationRetiredError,
  ReviewResourceReadError,
  type HunkSessionBrokerState,
  type ReviewPublicationEvent,
} from "./state";

/**
 * HTTP status each failure is reported with.
 *
 * Total over the code union, so a code added to any tier's vocabulary cannot reach this
 * surface without someone deciding what it means to a client.
 */
const REVIEW_ERROR_STATUS: Record<HunkReviewClientErrorCodeV1, number> = {
  "stale-generation": 409,
  "invalid-request": 400,
  "unsupported-action": 400,
  "file-not-found": 404,
  "hunk-not-found": 404,
  "gap-not-found": 404,
  "draft-missing": 409,
  "draft-active": 409,
  "draft-mode-mismatch": 409,
  "note-not-found": 404,
  "note-not-editable": 403,
  "note-has-replies": 409,
  "note-id-conflict": 409,
  "invalid-note-parent": 409,
  "blank-note": 400,
  "note-too-large": 413,
  "missing-fact": 400,
  "unknown-resource": 404,
  "resource-unavailable": 502,
  "resource-too-large": 413,
  "resource-integrity": 502,
  "invalid-range": 416,
  unauthorized: 401,
  "no-publication": 409,
  "payload-too-large": 413,
  "method-not-allowed": 405,
  "unsupported-media-type": 415,
  "forbidden-origin": 403,
  "too-many-streams": 503,
};

/**
 * Headers every review response carries.
 *
 * No caching (a review moves), no referrer (the capability is in the fragment and must not
 * travel), no framing, and a content policy that permits nothing — this surface serves
 * JSON, bytes, and an event stream, never a document that loads anything.
 */
const REVIEW_SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

/** How often an idle stream is kept alive. */
const DEFAULT_HEARTBEAT_MS = 15_000;

/** How many event streams the daemon keeps open, in total and for one review. */
const DEFAULT_MAX_STREAMS = 64;
const DEFAULT_MAX_STREAMS_PER_SESSION = 8;

/**
 * How many bytes one stream may fall behind before it is dropped.
 *
 * A reader that stops reading must not let the daemon buffer without limit; two whole
 * events' worth of slack is enough for a client that is merely slow and far too little for
 * one that has stopped.
 */
const DEFAULT_MAX_STREAM_BUFFER_BYTES = 2 * MAX_HUNK_REVIEW_ENVELOPE_BYTES;

export interface BrowserReviewServerOptions {
  heartbeatMs?: number;
  maxStreams?: number;
  maxStreamsPerSession?: number;
  maxStreamBufferBytes?: number;
  /** Admit one authorized action through the host daemon's shared HTTP control budgets. */
  handleActionControl?: (
    request: Request,
    handler: (body: Uint8Array) => Promise<Response>,
    payloadTooLarge: () => Response,
  ) => Promise<Response>;
  /** Smaller event chunking for tests; the protocol's bound still caps it. */
  eventChunkBytes?: number;
}

/** One open event stream, and the authorization it was opened under. */
interface ReviewEventStream {
  sessionId: string;
  capabilityDigest: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  /** The last position this stream was told about, which a farewell is addressed to. */
  address: ReviewPublicationAddress;
  closed: boolean;
}

/** One authorized request: which session, and the digest that authorized it. */
interface ReviewAuthorization {
  sessionId: string;
  capabilityDigest: string;
}

const TEXT_ENCODER = new TextEncoder();
const FATAL_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Digest one presented capability the same way the session digested it when minting. */
function capabilityDigest(token: string) {
  return nodeReviewDigest(TEXT_ENCODER.encode(token));
}

/** Compare two hex digests without letting the comparison time say how far it matched. */
function digestsMatchInConstantTime(presented: string, expected: string | undefined) {
  const presentedBytes = Buffer.from(presented, "hex");
  // An unknown session still costs a full comparison against random bytes of the same
  // width, so timing cannot be used to enumerate which sessions are being reviewed.
  const expectedBytes =
    expected && isReviewSha256Digest(expected)
      ? Buffer.from(expected, "hex")
      : randomBytes(presentedBytes.byteLength);
  return (
    presentedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(presentedBytes, expectedBytes) &&
    expected !== undefined
  );
}

/** Serve one daemon's review surface: publication, resources, events, and actions. */
export class BrowserReviewServer {
  private readonly streams = new Set<ReviewEventStream>();
  private readonly unsubscribe: () => void;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly state: HunkSessionBrokerState,
    private readonly options: BrowserReviewServerOptions = {},
  ) {
    this.unsubscribe = state.subscribeReviewPublications((event) => this.observe(event));
    this.heartbeat = setInterval(
      () => this.broadcastHeartbeat(),
      options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    );
    this.heartbeat.unref?.();
  }

  /**
   * Answer one request, or decline it as not a review route.
   *
   * `undefined` means "not mine", so the daemon's other routes and its 404 keep working
   * unchanged.
   */
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${HUNK_REVIEW_HTTP_PATH_PREFIX}/`)) {
      return undefined;
    }

    const origin = this.checkOrigin(request);
    if (origin) {
      return origin;
    }

    const route = parseReviewHttpPath(url.pathname);
    if (!route) {
      // Under the review prefix but not a route: answer as a review failure rather than
      // falling through, so a client gets this surface's error shape.
      return this.failure("invalid-request");
    }

    const authorization = this.authorize(request, route.sessionId);
    if (!authorization) {
      return this.failure("unauthorized");
    }

    switch (route.kind) {
      case "publication":
        return this.requireMethod(request, "GET") ?? this.handlePublication(route.sessionId);
      case "events":
        return this.requireMethod(request, "GET") ?? this.handleEvents(request, authorization);
      case "resource":
        return this.requireMethod(request, "GET") ?? this.handleResource(request, route);
      case "actions": {
        const methodError = this.requireMethod(request, "POST");
        if (methodError) return methodError;
        return this.options.handleActionControl
          ? this.options.handleActionControl(
              request,
              (body) => this.handleAction(request, route.sessionId, body),
              () => this.failure("payload-too-large"),
            )
          : this.handleAction(request, route.sessionId);
      }
    }
  }

  /** How many event streams are open, for lifecycle assertions. */
  getStreamCount() {
    return this.streams.size;
  }

  /** Close every stream and stop watching the daemon. */
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.heartbeat);
    this.unsubscribe();
    for (const stream of Array.from(this.streams)) {
      this.closeStream(stream);
    }
  }

  // -- Requests -------------------------------------------------------------------------

  /**
   * Refuse anything that is not this local surface talking to itself.
   *
   * Two independent checks. The Host must name a loopback address, so the daemon's review
   * routes answer only on the interface it is bound to even if something else forwards to
   * it; and an Origin, when a browser attaches one, must be this exact origin. No CORS
   * headers are ever sent, so a cross-origin page cannot read a response even if it
   * managed to send one.
   */
  private checkOrigin(request: Request): Response | undefined {
    const host = request.headers.get("host");
    const hostname = host ? host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "") : undefined;
    if (!allowsUnsafeRemoteSessionBroker() && (!hostname || !isLoopbackHost(hostname))) {
      return this.failure("forbidden-origin");
    }

    const origin = request.headers.get("origin");
    if (!origin) {
      return undefined;
    }
    const expected = `${new URL(request.url).protocol}//${host}`;
    return origin === expected ? undefined : this.failure("forbidden-origin");
  }

  /** Check the presented capability against the digest the session registered. */
  private authorize(request: Request, sessionId: string): ReviewAuthorization | undefined {
    const presented = request.headers.get(HUNK_REVIEW_CAPABILITY_HEADER);
    if (!isReviewCapabilityToken(presented)) {
      return undefined;
    }
    const expected = this.state.getReviewCapabilityDigest(sessionId);
    return digestsMatchInConstantTime(capabilityDigest(presented), expected)
      ? { sessionId, capabilityDigest: expected! }
      : undefined;
  }

  /** Reject a route reached with the wrong method before any work is done. */
  private requireMethod(request: Request, method: "GET" | "POST"): Response | undefined {
    return request.method === method ? undefined : this.failure("method-not-allowed");
  }

  /** Serve where one session's review is and what it offers there. */
  private handlePublication(sessionId: string): Response {
    const body = this.publicationBody(sessionId);
    return body ? this.json(body) : this.failure("no-publication");
  }

  /** Build the publication body, or nothing when the session publishes no review. */
  private publicationBody(sessionId: string): HunkReviewPublicationBodyV1 | undefined {
    const publication = this.state.getReviewPublication(sessionId);
    return publication
      ? {
          protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
          sessionId,
          publication: publication.address,
          catalog: publication.catalog,
        }
      : undefined;
  }

  /**
   * Serve one window of one published resource.
   *
   * The bytes come from the daemon's existing mirror-and-cache path, so they are
   * single-flighted, bounded, and verified against the digest the producer measured before
   * this surface ever sees them; there is no second read path. What is added here is HTTP
   * `Range` handling and the response cap, which are transport concerns.
   */
  private async handleResource(request: Request, route: HunkReviewHttpRoute): Promise<Response> {
    if (route.kind !== "resource") {
      return this.failure("invalid-request");
    }
    const descriptor = this.state
      .getReviewPublication(route.sessionId)
      ?.catalog.resources.find((resource) => resource.id === route.resourceId);
    const rangeHeader = request.headers.get("range");
    // A malformed range is refused before the read, so a bad header cannot make the daemon
    // materialize a resource for nothing.
    if (rangeHeader !== null && parseByteRange(rangeHeader) === undefined) {
      return this.rangeNotSatisfiable(undefined);
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.state.loadReviewResource(
        route.sessionId,
        route.generation,
        route.resourceId,
      );
    } catch (error) {
      return this.resourceFailure(error);
    }

    const range = rangeHeader === null ? undefined : parseByteRange(rangeHeader);
    if (range && (range.start >= bytes.byteLength || range.start > (range.end ?? Infinity))) {
      // A zero-length resource has no satisfiable range at all, which this covers: every
      // start is at or past its end.
      return this.rangeNotSatisfiable(bytes.byteLength);
    }

    const start = range?.start ?? 0;
    const requestedEnd = range?.end ?? bytes.byteLength - 1;
    // One response never carries more than the chunk size both ends already agree on, so a
    // client's window size and the server's cap cannot drift apart (D5).
    const end = Math.min(
      requestedEnd,
      bytes.byteLength - 1,
      start + REVIEW_RESOURCE_CHUNK_BYTES - 1,
    );
    const partial = range !== undefined || end !== bytes.byteLength - 1;
    const slice = bytes.slice(start, end + 1);

    return new Response(slice, {
      status: partial ? 206 : 200,
      headers: this.headers({
        "accept-ranges": "bytes",
        "content-type": descriptor?.contentType ?? "application/octet-stream",
        ...(partial
          ? { "content-range": `bytes ${start}-${Math.max(start, end)}/${bytes.byteLength}` }
          : {}),
      }),
    });
  }

  /**
   * Apply one action on behalf of a remote caller.
   *
   * The body is parsed by `parseHunkReviewActionEnvelope` and by nothing else — the
   * prototype grew a second envelope parser here, which is how the two ends came to
   * disagree about which fields an action may carry (D5) — and the parsed action is handed
   * to the daemon's existing forwarding path, which plans it at the producer through the
   * same intent the keyboard uses.
   */
  private async handleAction(
    request: Request,
    sessionId: string,
    bodyBytes?: Uint8Array,
  ): Promise<Response> {
    if (!hasJsonContentType(request)) {
      return this.failure("unsupported-media-type");
    }

    let value: unknown;
    try {
      const maxBytes = Math.min(MAX_HUNK_REVIEW_ENVELOPE_BYTES, MAX_HTTP_BODY_BYTES);
      let text: string;
      if (bodyBytes === undefined) {
        text = await readRequestTextWithLimit(request, maxBytes);
      } else {
        if (bodyBytes.byteLength > maxBytes) throw new PayloadTooLargeError(maxBytes);
        text = FATAL_TEXT_DECODER.decode(bodyBytes);
      }
      value = JSON.parse(text);
    } catch (error) {
      return this.failure(
        error instanceof PayloadTooLargeError ? "payload-too-large" : "invalid-request",
      );
    }

    const envelope = parseHunkReviewActionEnvelope(value);
    if (!envelope.ok) {
      return this.failure(
        envelope.reason === "unsupported" ? "unsupported-action" : "invalid-request",
      );
    }

    try {
      const result = await this.state.applyReviewAction(
        sessionId,
        envelope.value.generation,
        envelope.value.action,
        {
          actor: envelope.value.actor,
          ...(envelope.value.expectedStateRevision !== undefined
            ? { expectedStateRevision: envelope.value.expectedStateRevision }
            : {}),
        },
      );
      return result.ok
        ? this.json(result)
        : this.failure(result.code, {
            message: result.message,
            currentGeneration: result.currentGeneration,
          });
    } catch (error) {
      if (error instanceof ReviewGenerationRetiredError) {
        return this.failure("stale-generation", { currentGeneration: error.currentGeneration });
      }
      throw error;
    }
  }

  // -- Events ---------------------------------------------------------------------------

  /**
   * Open one event stream for a session, starting with where its review is now.
   *
   * The first event is always a complete publication, which is also this surface's answer
   * to any `Last-Event-ID` a reconnecting client sends: the stream carries no deltas, so a
   * fresh publication is a complete resynchronization and a replay buffer would only be an
   * optimization. Deciding whether to reconnect at all, and how soon, stays with the
   * client (`docs/browser-review-seam-audit.md`, C5).
   */
  private handleEvents(request: Request, auth: ReviewAuthorization): Response {
    const { sessionId } = auth;
    const opening = this.publicationBody(sessionId);
    if (!opening) {
      return this.failure("no-publication");
    }
    const perSession = Array.from(this.streams).filter(
      (stream) => stream.sessionId === sessionId,
    ).length;
    if (
      this.streams.size >= (this.options.maxStreams ?? DEFAULT_MAX_STREAMS) ||
      perSession >= (this.options.maxStreamsPerSession ?? DEFAULT_MAX_STREAMS_PER_SESSION)
    ) {
      return this.failure("too-many-streams");
    }

    let stream!: ReviewEventStream;
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          stream = {
            sessionId,
            capabilityDigest: auth.capabilityDigest,
            controller,
            address: opening.publication,
            closed: false,
          };
          this.streams.add(stream);
          this.sendPublication(stream);
        },
        cancel: () => this.removeStream(stream),
      },
      new ByteLengthQueuingStrategy({
        highWaterMark: this.options.maxStreamBufferBytes ?? DEFAULT_MAX_STREAM_BUFFER_BYTES,
      }),
    );

    if (request.signal.aborted) {
      this.closeStream(stream);
    } else {
      request.signal.addEventListener("abort", () => this.closeStream(stream), { once: true });
    }

    return new Response(body, {
      headers: this.headers({
        "content-type": REVIEW_EVENT_STREAM_CONTENT_TYPE,
        // Proxies that buffer a stream defeat the point of one.
        "x-accel-buffering": "no",
      }),
    });
  }

  /** Turn one mirror observation into what every stream watching that session should see. */
  private observe(event: ReviewPublicationEvent) {
    for (const stream of Array.from(this.streams)) {
      if (stream.sessionId !== event.sessionId) {
        continue;
      }
      if (event.kind === "retired") {
        // Checked before authorization, because a retired session has no capability left
        // to match: a watcher is owed the farewell it has been waiting for.
        this.sendDisconnect(stream);
        continue;
      }
      if (this.state.getReviewCapabilityDigest(stream.sessionId) !== stream.capabilityDigest) {
        // The session re-registered under a different capability: this stream's
        // authorization no longer exists, so it ends rather than keeps receiving.
        this.closeStream(stream);
        continue;
      }
      this.sendPublication(stream);
    }
  }

  /** Send the current publication, or end the stream when there is no longer one. */
  private sendPublication(stream: ReviewEventStream) {
    const body = this.publicationBody(stream.sessionId);
    const publication = this.state.getReviewPublication(stream.sessionId);
    if (!body || !publication) {
      this.sendDisconnect(stream);
      return;
    }
    this.sendEvent(stream, "publication", publication.address, body);
  }

  /** Tell one stream its review is gone, then end it. */
  private sendDisconnect(stream: ReviewEventStream) {
    // Addressed to the last position this stream was told about, because by the time a
    // session is gone the daemon no longer holds one.
    this.sendEvent(stream, "disconnect", stream.address, { sessionId: stream.sessionId });
    this.closeStream(stream);
  }

  /** Frame one event through the shared protocol and enqueue it. */
  private sendEvent(
    stream: ReviewEventStream,
    type: ReviewEventTypeV1,
    address: ReviewPublicationAddress,
    body: unknown,
  ) {
    if (stream.closed) {
      return;
    }
    stream.address = address;
    const payload = TEXT_ENCODER.encode(JSON.stringify(body));
    let frames;
    try {
      frames = planReviewEventFrames({
        type,
        address,
        body,
        payload,
        contentDigest: nodeReviewDigest(payload),
        encodeChunk: (bytes) => Buffer.from(bytes).toString("base64"),
        chunkBytes: Math.min(
          this.options.eventChunkBytes ?? REVIEW_EVENT_CHUNK_BYTES,
          REVIEW_EVENT_CHUNK_BYTES,
        ),
      });
    } catch (error) {
      if (error instanceof ReviewEventTooLargeError) {
        // Nothing a client can do about a review too large to stream, and half of one is
        // worse than none: end the stream instead of sending a truncated event.
        this.closeStream(stream);
        return;
      }
      throw error;
    }
    for (const frame of frames) {
      this.write(stream, TEXT_ENCODER.encode(encodeReviewEventFrame(frame)));
    }
  }

  /** Keep idle streams and the proxies between them alive. */
  private broadcastHeartbeat() {
    const heartbeat = TEXT_ENCODER.encode(REVIEW_EVENT_HEARTBEAT_FRAME);
    for (const stream of Array.from(this.streams)) {
      this.write(stream, heartbeat);
    }
  }

  /** Enqueue bytes, dropping a stream that has fallen further behind than it may. */
  private write(stream: ReviewEventStream, bytes: Uint8Array) {
    if (stream.closed) {
      return;
    }
    try {
      stream.controller.enqueue(bytes);
    } catch {
      this.removeStream(stream);
      return;
    }
    const budget = this.options.maxStreamBufferBytes ?? DEFAULT_MAX_STREAM_BUFFER_BYTES;
    // `desiredSize` goes negative by exactly the bytes queued beyond the mark, so this is
    // "the reader is a whole budget behind" rather than "the reader is merely slow".
    if ((stream.controller.desiredSize ?? 0) <= -budget) {
      this.closeStream(stream, new Error("The review event stream fell too far behind."));
    }
  }

  /** Close one stream, optionally reporting why. */
  private closeStream(stream: ReviewEventStream, error?: Error) {
    if (!stream || stream.closed) {
      return;
    }
    this.removeStream(stream);
    try {
      if (error) {
        stream.controller.error(error);
      } else {
        stream.controller.close();
      }
    } catch {
      // Already torn down by the transport.
    }
  }

  /** Forget one stream exactly once. */
  private removeStream(stream: ReviewEventStream) {
    if (!stream || stream.closed) {
      return;
    }
    stream.closed = true;
    this.streams.delete(stream);
  }

  // -- Responses ------------------------------------------------------------------------

  private headers(extra: HeadersInit = {}) {
    const headers = new Headers(REVIEW_SECURITY_HEADERS);
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return headers;
  }

  private json(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: this.headers({ "content-type": "application/json; charset=utf-8" }),
    });
  }

  /**
   * Answer one failure in the shape every review route uses.
   *
   * The message comes from the shared catalog unless the producer supplied a more specific
   * one, so a client never has to invent wording for a code (G4).
   */
  private failure(
    code: HunkReviewClientErrorCodeV1,
    details: { message?: string; currentGeneration?: string } = {},
  ) {
    const body: HunkReviewHttpFailureV1 = {
      ok: false,
      code,
      message: details.message ?? reviewErrorMessage(code),
      ...(details.currentGeneration ? { currentGeneration: details.currentGeneration } : {}),
    };
    return this.json(body, REVIEW_ERROR_STATUS[code]);
  }

  /** Report one resource read failure with the code that says how it failed. */
  private resourceFailure(error: unknown) {
    if (error instanceof ReviewResourceReadError) {
      return this.failure(error.code, { message: error.message });
    }
    if (error instanceof ReviewGenerationRetiredError) {
      return this.failure("stale-generation", { currentGeneration: error.currentGeneration });
    }
    return this.failure("resource-unavailable");
  }

  /** Refuse one range, telling the client the size it should have asked within. */
  private rangeNotSatisfiable(size: number | undefined) {
    return new Response(null, {
      status: REVIEW_ERROR_STATUS["invalid-range"],
      headers: this.headers(size === undefined ? {} : { "content-range": `bytes */${size}` }),
    });
  }
}

/** Return whether one body was explicitly sent as JSON. */
function hasJsonContentType(request: Request) {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

/**
 * Parse one single-range `Range` header.
 *
 * Only the one form this surface serves — `bytes=start-` or `bytes=start-end`. Multi-range
 * and suffix ranges are not supported and are refused rather than approximated, because a
 * client that asked for something it will not get should be told so.
 */
export function parseByteRange(header: string): { start: number; end?: number } | undefined {
  const match = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(header.trim());
  if (!match) {
    return undefined;
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start)) {
    return undefined;
  }
  if (match[2] === "") {
    return { start };
  }
  const end = Number(match[2]);
  return Number.isSafeInteger(end) && end >= start ? { start, end } : undefined;
}
