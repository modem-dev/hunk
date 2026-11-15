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
 * superseding loads belong to the mirror (`../mirror/reviewMirror.ts`).
 */
import {
  REVIEW_RESOURCE_CHUNK_BYTES,
  REVIEW_RESOURCE_LOAD_CONCURRENCY,
  reviewResourceCeiling,
  type ReviewResourceDescriptorV1,
} from "../../core/review/resources";
import { ReviewChunkAssembler } from "../../core/review/resourceAssembly";
import type { ReviewAsyncDigestFn } from "../../core/review/validation";
import { REVIEW_ERROR_CATALOG } from "../../session/reviewErrorCatalog";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  reviewHttpPath,
  type HunkReviewClientErrorCodeV1,
  type HunkReviewHttpRoute,
  type HunkReviewPublicationBodyV1,
  type HunkReviewStateBodyV1,
} from "../../session/reviewHttpProtocol";
import {
  HUNK_REVIEW_PROTOCOL_VERSION,
  isHunkReviewIndex,
  parseHunkReviewPublicationAddress,
  parseHunkReviewResourceCatalog,
  type HunkReviewActionEnvelopeV1,
} from "../../session/reviewProtocol";
import { parseReviewSharedState } from "../../session/reviewSharedState";
import { webCryptoReviewDigest } from "./webCryptoDigest";

/**
 * Why one request failed, in the shared vocabulary where the server stated one.
 *
 * `network` means the daemon did not answer; `unreadable` means it answered with something
 * this build cannot parse. Neither is a review code, because neither came from a review.
 */
export type ReviewApiErrorCode = HunkReviewClientErrorCodeV1 | "network" | "unreadable";

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
export function isReviewClientErrorCode(value: unknown): value is HunkReviewClientErrorCodeV1 {
  return typeof value === "string" && Object.hasOwn(REVIEW_ERROR_CATALOG, value);
}

/** Parse one publication body, refusing anything the shared parsers refuse. */
export function parseReviewPublicationBody(
  value: unknown,
): HunkReviewPublicationBodyV1 | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const publication = parseHunkReviewPublicationAddress(record.publication);
  const catalog = parseHunkReviewResourceCatalog(record.catalog);
  if (
    record.protocolVersion !== HUNK_REVIEW_PROTOCOL_VERSION ||
    typeof record.sessionId !== "string" ||
    !publication ||
    !catalog ||
    catalog.generation !== publication.generation ||
    (record.sharedStateRevision !== undefined && !isHunkReviewIndex(record.sharedStateRevision))
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
export function parseReviewStateBody(value: unknown): HunkReviewStateBodyV1 | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const publication = parseHunkReviewPublicationAddress(record.publication);
  const state = parseReviewSharedState(record.state);
  if (
    record.protocolVersion !== HUNK_REVIEW_PROTOCOL_VERSION ||
    typeof record.sessionId !== "string" ||
    !publication ||
    !state ||
    !isHunkReviewIndex(record.sharedStateRevision) ||
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
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
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
  async publication(signal?: AbortSignal): Promise<HunkReviewPublicationBodyV1> {
    const response = await this.request(
      { kind: "publication", sessionId: this.sessionId },
      {
        signal,
      },
    );
    let body: HunkReviewPublicationBodyV1 | undefined;
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
  async state(signal?: AbortSignal): Promise<HunkReviewStateBodyV1> {
    const response = await this.request({ kind: "state", sessionId: this.sessionId }, { signal });
    let body: HunkReviewStateBodyV1 | undefined;
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

  /** Send one review action; resolves once the session applied it. */
  async postAction(envelope: HunkReviewActionEnvelopeV1, signal?: AbortSignal): Promise<void> {
    await this.request(
      { kind: "actions", sessionId: this.sessionId },
      {
        signal,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      },
    );
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
    descriptor: ReviewResourceDescriptorV1,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const route: HunkReviewHttpRoute = {
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
   * Results arrive in completion order; `onResult` receives the descriptor's index so a
   * caller can place it. The first failure stops new reads and rejects; reads already in
   * flight finish but are not reported. Aborting the signal stops everything.
   */
  async readResources(
    descriptors: readonly ReviewResourceDescriptorV1[],
    onResult: (index: number, bytes: Uint8Array) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let next = 0;
    let failure: unknown;
    const worker = async () => {
      while (failure === undefined && next < descriptors.length) {
        signal?.throwIfAborted();
        const index = next;
        next += 1;
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
    descriptor: ReviewResourceDescriptorV1,
    windows: readonly Uint8Array[],
    total: number,
  ) {
    // The HTTP surface carries no digest for an unmeasured resource, so the bytes' own
    // digest stands in and only the window rules are checked (see `readResource`).
    const contentDigest = descriptor.digest ?? (await this.digest(concatenate(windows, total)));
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

    const result = await assembler.finishAsync(this.digest);
    if (!result.ok) {
      throw new ReviewApiError(result.code, result.message);
    }
    return result.bytes;
  }

  /** Send one request with the capability header, turning refusals into typed errors. */
  private async request(
    route: HunkReviewHttpRoute,
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
