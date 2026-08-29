/**
 * Hard size ceilings for everything the session broker parses or stores from the network.
 *
 * The broker is loopback-only by default, but a hostile or buggy local process (and any remote
 * peer when HUNK_MCP_UNSAFE_ALLOW_REMOTE=1) can otherwise stream unbounded HTTP bodies or
 * websocket frames, or register a changeset with an unbounded number of files, hunks, comments,
 * or patch bytes. These caps keep memory bounded while staying far above any realistic review.
 */

import {
  DEFAULT_SESSION_BROKER_LIMITS,
  BrokerCapacityError,
  ReservationGroup,
  type BudgetReservation,
  type ResourceBudget,
} from "./budgets";

/** Maximum decoded byte length accepted for one HTTP API request body. */
export const MAX_HTTP_BODY_BYTES = DEFAULT_SESSION_BROKER_LIMITS.maxHttpBodyBytes;

/** Maximum byte length accepted for one inbound websocket message. */
export const MAX_WS_MESSAGE_BYTES = DEFAULT_SESSION_BROKER_LIMITS.maxWsMessageBytes;

/** Maximum number of files accepted in one session registration payload. */
export const MAX_REGISTRATION_FILES = 5_000;

/** Maximum number of hunks accepted per registered file. */
export const MAX_REGISTRATION_HUNKS_PER_FILE = 10_000;

/** Maximum byte length accepted for one registered file's patch text. */
export const MAX_REGISTRATION_PATCH_BYTES = 2 * 1024 * 1024;

/** Maximum number of live comments accepted in one session snapshot. */
export const MAX_SNAPSHOT_LIVE_COMMENTS = 10_000;

/** Maximum number of review notes accepted in one session snapshot. */
export const MAX_SNAPSHOT_REVIEW_NOTES = 10_000;

/** Raised when an inbound payload exceeds its configured byte budget. */
export class PayloadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Payload exceeds the ${limitBytes}-byte session broker limit.`);
    this.name = "PayloadTooLargeError";
  }
}

/** Raised when Content-Length is ambiguous instead of a canonical non-negative integer. */
export class InvalidContentLengthError extends Error {
  constructor() {
    super("Content-Length must be a canonical non-negative integer.");
    this.name = "InvalidContentLengthError";
  }
}

// Reused across every websocket message, HTTP body, and patch check to avoid a per-call alloc.
const sharedTextEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 byte length of a string without allocating a Buffer in non-Node runtimes. */
export function utf8ByteLength(value: string): number {
  return sharedTextEncoder.encode(value).length;
}

/**
 * Read one request body as exact bytes while enforcing a hard byte ceiling.
 *
 * The Content-Length header is rejected early when it already declares an oversized body, and the
 * stream is aborted mid-read so a missing or lying Content-Length cannot force the daemon to
 * buffer an unbounded body before the cap is noticed.
 */
export async function readRequestBytesWithReservation(
  request: Request,
  maxBytes: number,
  aggregateBudget?: ResourceBudget,
): Promise<{ bytes: Uint8Array; reservation: BudgetReservation }> {
  const declaredHeader = request.headers.get("content-length");
  if (declaredHeader !== null && !/^(?:0|[1-9][0-9]*)$/.test(declaredHeader)) {
    throw new InvalidContentLengthError();
  }
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > maxBytes)) {
    throw new PayloadTooLargeError(maxBytes);
  }

  const reservations = new ReservationGroup();
  try {
    if (aggregateBudget && declared !== null) reservations.add(aggregateBudget.reserve(declared));
    const body = request.body;
    if (!body) return { bytes: new Uint8Array(), reservation: reservations };

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        const nextTotal = total + value.byteLength;
        if (nextTotal > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new PayloadTooLargeError(maxBytes);
        }
        if (aggregateBudget && nextTotal > (declared ?? 0)) {
          reservations.add(aggregateBudget.reserve(nextTotal - Math.max(total, declared ?? 0)));
        }
        total = nextTotal;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes: merged, reservation: reservations };
  } catch (error) {
    reservations.release();
    throw error;
  }
}

/** Buffer one finite non-SSE response under the shared hard response and in-flight budget. */
export async function boundHttpResponse(
  response: Response,
  maxBytes: number,
  aggregateBudget?: ResourceBudget,
): Promise<Response> {
  if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    return response;
  }
  const declared = response.headers.get("content-length");
  if (declared && /^(?:0|[1-9][0-9]*)$/.test(declared) && Number(declared) > maxBytes) {
    return new Response(null, { status: 503 });
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const reservations = new ReservationGroup();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return new Response(null, { status: 503 });
      }
      if (aggregateBudget) reservations.add(aggregateBudget.reserve(value.byteLength));
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers = new Headers(response.headers);
    headers.set("content-length", String(total));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    if (error instanceof BrokerCapacityError) {
      await reader.cancel().catch(() => {});
      return new Response(null, { status: 503 });
    }
    throw error;
  } finally {
    reservations.release();
    reader.releaseLock();
  }
}

export async function readRequestBytesWithLimit(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const { bytes, reservation } = await readRequestBytesWithReservation(request, maxBytes);
  reservation.release();
  return bytes;
}

/** Read and strictly decode one bounded request body as UTF-8 text. */
export async function readRequestTextWithLimit(
  request: Request,
  maxBytes: number,
): Promise<string> {
  return fatalTextDecoder.decode(await readRequestBytesWithLimit(request, maxBytes));
}
