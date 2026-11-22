/**
 * Talks to one session's review API on the daemon that served this page.
 *
 * Every request presents the capability in its header and nowhere else — never in a path,
 * a query string, a log line, or storage. Routes, header names, and wire shapes come from
 * the browser-safe session modules; resource bytes are read in ranged windows and assembled
 * and verified by the shared `ReviewChunkAssembler`, so the browser applies exactly the
 * offset, size, progress, and digest rules the daemon does (`docs/browser-review-seam-audit.md`,
 * C2). Failures arrive as `ReviewApiError` carrying the review vocabulary's code.
 *
 * This module owns requests only. Ordering publications, deciding what to load, and
 * superseding loads belong to the mirror (`../mirror/clientReviewMirror.ts`).
 */
import {
  REVIEW_RESOURCE_CHUNK_BYTES,
  REVIEW_RESOURCE_LOAD_CONCURRENCY,
  reviewResourceCeiling,
  type ReviewResourceDescriptor,
} from "../../core/review/resources";
import { ReviewChunkAssembler } from "../../core/review/resourceAssembly";
import type { ReviewAsyncDigestFn } from "../../core/review/validation";
import { REVIEW_ERROR_CATALOG } from "../../session/reviewErrorCatalog";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  reviewHttpPath,
  type ReviewHttpFailureCode,
  type ReviewHttpRoute,
  type ReviewPublicationBody,
  type ReviewStateBody,
} from "../../session/reviewHttpProtocol";
import {
  HUNK_REVIEW_PROTOCOL_VERSION,
  isReviewIndex,
  parseReviewPublicationAddress,
  parseReviewResourceCatalog,
  type ReviewActionApplied,
  type ReviewActionEnvelope,
} from "../../session/reviewProtocol";
import type { ReviewPublicationAddress } from "../../core/review/generationOrder";
import { parseReviewSharedState } from "../../session/reviewSharedState";
import { webCryptoReviewDigest } from "./webCryptoDigest";

/**
 * Why one request failed, in the shared vocabulary where the server stated one.
 *
 * `network` means the daemon did not answer; `unreadable` means it answered with something
 * this build cannot parse; `session-ended` means the page refused to send because the session's
 * event stream has ended. None is a review code, because none came from a review.
 */
export type ReviewApiErrorCode = ReviewHttpFailureCode | "network" | "unreadable" | "session-ended";

/** One refused or failed request. */
export class ReviewApiError extends Error {
  override readonly name = "ReviewApiError";

  constructor(
    readonly code: ReviewApiErrorCode,
    message: string,
    readonly details: { status?: number; currentGeneration?: string } = {},
  ) {
    super(message);
  }
}

/** Whether one value is a code the shared error catalog documents. */
export function isReviewClientErrorCode(value: unknown): value is ReviewHttpFailureCode {
  return typeof value === "string" && Object.hasOwn(REVIEW_ERROR_CATALOG, value);
}

/** Parse one publication body, refusing anything the shared parsers refuse. */
export function parseReviewPublicationBody(value: unknown): ReviewPublicationBody | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const publication = parseReviewPublicationAddress(record.publication);
  const catalog = parseReviewResourceCatalog(record.catalog);
  if (
    record.protocolVersion !== HUNK_REVIEW_PROTOCOL_VERSION ||
    typeof record.sessionId !== "string" ||
    !publication ||
    !catalog ||
    catalog.generation !== publication.generation ||
    (record.sharedStateRevision !== undefined && !isReviewIndex(record.sharedStateRevision))
  ) {
    return undefined;
  }
  return {
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    sessionId: record.sessionId,
    publication,
    ...(record.sharedStateRevision !== undefined
      ? { sharedStateRevision: record.sharedStateRevision as number }
      : {}),
    catalog,
  };
}

/**
 * Parse one shared-state body: the snapshot through the shared strict parser, and the
 * envelope's position agreeing with the position the snapshot names.
 */
export function parseReviewStateBody(value: unknown): ReviewStateBody | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const publication = parseReviewPublicationAddress(record.publication);
  const state = parseReviewSharedState(record.state);
  if (
    record.protocolVersion !== HUNK_REVIEW_PROTOCOL_VERSION ||
    typeof record.sessionId !== "string" ||
    !publication ||
    !state ||
    !isReviewIndex(record.sharedStateRevision) ||
    state.sharedStateRevision !== record.sharedStateRevision ||
    state.generation !== publication.generation
  ) {
    return undefined;
  }
  return {
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    sessionId: record.sessionId,
    publication,
    sharedStateRevision: record.sharedStateRevision,
    state,
  };
}

/** Turn one refused response into a typed error carrying the server's code. */
async function refusal(response: Response): Promise<ReviewApiError> {
  try {
    const body = (await response.json()) as {
      code?: unknown;
      message?: unknown;
      currentGeneration?: unknown;
    };
    if (isReviewClientErrorCode(body.code)) {
      return new ReviewApiError(
        body.code,
        typeof body.message === "string" ? body.message : body.code,
        {
          status: response.status,
          ...(typeof body.currentGeneration === "string"
            ? { currentGeneration: body.currentGeneration }
            : {}),
        },
      );
    }
  } catch {
    // Not a review failure body.
  }
  return new ReviewApiError("unreadable", `The review API answered ${response.status}.`, {
    status: response.status,
  });
}

/** Return the total size a `content-range` header reports, if it reports one. */
function rangeTotal(header: string | null) {
  const match = header ? /^bytes \d+-\d+\/(\d+)$/.exec(header.trim()) : null;
  return match ? Number(match[1]) : undefined;
}

/** Join byte windows into one array. */
function concatenate(parts: readonly Uint8Array[], total: number) {
  if (parts.length === 1 && parts[0]!.byteLength === total) return parts[0]!;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/**
 * Picks the next resource a free read slot takes, by its index in the descriptors read;
 * `undefined` once nothing is left. Each index must be handed out at most once.
 */
export interface ReviewResourceReadOrder {
  next(): number | undefined;
}

/** Hand out `0..count-1` in order. */
function inGivenOrder(count: number): ReviewResourceReadOrder {
  let next = 0;
  return { next: () => (next < count ? next++ : undefined) };
}

/** The one `fetch` shape the client uses, so tests can inject a fake. */
export type ReviewFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ReviewApiClientOptions {
  sessionId: string;
  capability: string;
  /** Injected for tests; defaults to the page's `fetch`. */
  fetch?: ReviewFetch;
  /** Injected for tests; defaults to Web Crypto. */
  digest?: ReviewAsyncDigestFn;
  /** Resource reads in flight at once; defaults to the shared bound. */
  concurrency?: number;
}

/** Requests against one session's review API. */
export class ReviewApiClient {
  readonly sessionId: string;
  private readonly capability: string;
  private readonly fetcher: ReviewFetch;
  private readonly digest: ReviewAsyncDigestFn;
  private readonly concurrency: number;

  constructor(options: ReviewApiClientOptions) {
    this.sessionId = options.sessionId;
    this.capability = options.capability;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.digest = options.digest ?? webCryptoReviewDigest;
    this.concurrency = Math.max(1, options.concurrency ?? REVIEW_RESOURCE_LOAD_CONCURRENCY);
  }

  /** Read where the review is and what it offers there. */
  async publication(signal?: AbortSignal): Promise<ReviewPublicationBody> {
    const response = await this.request(
      { kind: "publication", sessionId: this.sessionId },
      {
        signal,
      },
    );
    let body: ReviewPublicationBody | undefined;
    try {
      body = parseReviewPublicationBody(await response.json());
    } catch {
      body = undefined;
    }
    if (!body || body.sessionId !== this.sessionId) {
      throw new ReviewApiError("unreadable", "The review publication could not be read.");
    }
    return body;
  }

  /** Read the review's shared state: notes, filter, file index, and presentation defaults. */
  async state(signal?: AbortSignal): Promise<ReviewStateBody> {
    const response = await this.request({ kind: "state", sessionId: this.sessionId }, { signal });
    let body: ReviewStateBody | undefined;
    try {
      body = parseReviewStateBody(await response.json());
    } catch {
      body = undefined;
    }
    if (!body || body.sessionId !== this.sessionId) {
      throw new ReviewApiError("unreadable", "The review's shared state could not be read.");
    }
    return body;
  }

  /** Send one review action; resolves with the position it was applied at. */
  async postAction(
    envelope: ReviewActionEnvelope,
    signal?: AbortSignal,
  ): Promise<ReviewActionApplied> {
    const response = await this.request(
      { kind: "actions", sessionId: this.sessionId },
      {
        signal,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      },
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (
      record.ok !== true ||
      typeof record.generation !== "string" ||
      !isReviewIndex(record.stateRevision)
    ) {
      throw new ReviewApiError("unreadable", "The review action's answer could not be read.");
    }
    return { ok: true, generation: record.generation, stateRevision: record.stateRevision };
  }

  /** Ask the session to reload its input, as its own `r` key would. */
  async refresh(signal?: AbortSignal): Promise<ReviewPublicationAddress> {
    const response = await this.request(
      { kind: "refresh", sessionId: this.sessionId },
      { signal, method: "POST" },
    );
    let publication: ReviewPublicationAddress | undefined;
    try {
      const body = (await response.json()) as Record<string, unknown>;
      publication = body.ok === true ? parseReviewPublicationAddress(body.publication) : undefined;
    } catch {
      publication = undefined;
    }
    if (!publication) {
      throw new ReviewApiError("unreadable", "The refresh's answer could not be read.");
    }
    return publication;
  }

  /** Open the session's event stream; the caller reads and closes the body. */
  async openEvents(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const response = await this.request(
      { kind: "events", sessionId: this.sessionId },
      { signal, headers: { accept: "text/event-stream" } },
    );
    if (!response.body) {
      throw new ReviewApiError("unreadable", "The review event stream has no body.");
    }
    return response.body;
  }

  /**
   * Read one whole resource in ranged windows, verified by the shared assembler.
   *
   * A measured descriptor fixes the size and digest up front, and the assembled bytes must
   * hash to that digest. An unmeasured one adopts the size the first window reports; its
   * digest is not on the wire, so integrity then rests on the daemon, which verified the
   * bytes against the producer's measurement before serving them.
   */
  async readResource(
    descriptor: ReviewResourceDescriptor,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const route: ReviewHttpRoute = {
      kind: "resource",
      sessionId: this.sessionId,
      generation: descriptor.generation,
      resourceId: descriptor.id,
    };
    const windows: Uint8Array[] = [];
    let received = 0;
    let total = descriptor.byteLength;

    do {
      const end = received + REVIEW_RESOURCE_CHUNK_BYTES - 1;
      // The first window is asked for without a range: the server caps it at one chunk
      // anyway, and a zero-length resource has no satisfiable range at all.
      const response = await this.request(route, {
        signal,
        ...(received > 0 ? { headers: { range: `bytes=${received}-${end}` } } : {}),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const declared =
        response.status === 206
          ? rangeTotal(response.headers.get("content-range"))
          : bytes.byteLength;
      if (declared === undefined) {
        throw new ReviewApiError("unreadable", `Review resource ${descriptor.id} sent no size.`);
      }
      if (total !== undefined && declared !== total) {
        throw new ReviewApiError(
          "resource-integrity",
          `Review resource ${descriptor.id} changed its declared size mid-read.`,
        );
      }
      total = declared;
      windows.push(bytes);
      received += bytes.byteLength;
      if (bytes.byteLength === 0 && received < total) {
        throw new ReviewApiError(
          "resource-integrity",
          `Review resource ${descriptor.id} made no progress.`,
        );
      }
    } while (received < (total ?? 0));

    return this.assemble(descriptor, windows, total ?? 0);
  }

  /**
   * Read many resources with bounded parallelism, reporting each as it lands.
   *
   * Each free slot asks `order` which descriptor to read next, so a caller can reorder what
   * has not started yet (the files a reader is looking at) while reads run; without one,
   * descriptors are read in the order given. Results arrive in completion order; `onResult`
   * receives the descriptor's index so a caller can place it. The first failure stops new
   * reads and rejects; reads already in flight finish but are not reported. Aborting the
   * signal stops everything.
   */
  async readResources(
    descriptors: readonly ReviewResourceDescriptor[],
    onResult: (index: number, bytes: Uint8Array) => void,
    signal?: AbortSignal,
    order: ReviewResourceReadOrder = inGivenOrder(descriptors.length),
  ): Promise<void> {
    let failure: unknown;
    const worker = async () => {
      while (failure === undefined) {
        signal?.throwIfAborted();
        const index = order.next();
        if (index === undefined) return;
        try {
          const bytes = await this.readResource(descriptors[index]!, signal);
          if (failure === undefined && !signal?.aborted) {
            onResult(index, bytes);
          }
        } catch (error) {
          failure ??= error;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, descriptors.length) }, worker),
    );
    signal?.throwIfAborted();
    if (failure !== undefined) {
      throw failure;
    }
  }

  /** Feed received windows through the shared assembler and verify the result. */
  private async assemble(
    descriptor: ReviewResourceDescriptor,
    windows: readonly Uint8Array[],
    total: number,
  ) {
    // The HTTP surface carries no digest for an unmeasured resource, so the bytes' own
    // digest stands in and only the window rules are checked (see `readResource`). Those
    // same bytes then verify against it by construction, so they are hashed once.
    const ownDigest =
      descriptor.digest === undefined ? await this.digest(concatenate(windows, total)) : undefined;
    const contentDigest = descriptor.digest ?? ownDigest!;
    const assembler = new ReviewChunkAssembler({
      resourceId: descriptor.id,
      generation: descriptor.generation,
      maxBytes: reviewResourceCeiling(descriptor.kind),
      ...(descriptor.byteLength !== undefined && descriptor.digest !== undefined
        ? { expected: { byteLength: descriptor.byteLength, digest: descriptor.digest } }
        : {}),
    });

    let offset = 0;
    const steps = windows.length === 0 ? [new Uint8Array(0)] : windows;
    for (const [index, bytes] of steps.entries()) {
      const step = assembler.accept({
        chunk: {
          generation: descriptor.generation,
          resourceId: descriptor.id,
          offset,
          byteLength: bytes.byteLength,
          encoding: "base64",
          data: "",
          contentDigest,
          contentSize: total,
          eof: index === steps.length - 1,
        },
        bytes,
      });
      if (!step.ok) {
        throw new ReviewApiError(step.code, step.message);
      }
      offset += bytes.byteLength;
    }

    const result = await assembler.finishAsync(
      ownDigest === undefined ? this.digest : async () => ownDigest,
    );
    if (!result.ok) {
      throw new ReviewApiError(result.code, result.message);
    }
    return result.bytes;
  }

  /** Send one request with the capability header, turning refusals into typed errors. */
  private async request(
    route: ReviewHttpRoute,
    init: {
      signal?: AbortSignal;
      headers?: Record<string, string>;
      method?: "GET" | "POST";
      body?: string;
    },
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(HUNK_REVIEW_CAPABILITY_HEADER, this.capability);
    let response: Response;
    try {
      response = await this.fetcher(reviewHttpPath(route), {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (error) {
      if (init.signal?.aborted) {
        throw init.signal.reason ?? error;
      }
      throw new ReviewApiError("network", "The Hunk session daemon did not answer.");
    }
    if (!response.ok) {
      throw await refusal(response);
    }
    return response;
  }
}
