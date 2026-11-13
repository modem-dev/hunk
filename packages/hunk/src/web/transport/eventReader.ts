/**
 * Reads a session's review event stream from a `fetch` response body.
 *
 * The browser cannot use `EventSource`: the capability travels in a header, which
 * `EventSource` cannot set. This reader splits the body into Server-Sent Events records —
 * the generic `id:`/`event:`/`data:` text format, nothing review-specific — and hands every
 * record to the shared contract in `session/reviewEventProtocol.ts`: frame names, the
 * single-frame/begin/chunk/end envelopes and their parsers, the event-id grammar, and the
 * `ReviewEventAssembler` that reassembles and verifies chunked payloads. No frame name,
 * envelope, or bound is declared here (`docs/browser-review-seam-audit.md`, C4).
 */
import type { ReviewPublicationAddress } from "../../core/review/generationOrder";
import type { ReviewAsyncDigestFn } from "../../core/review/validation";
import {
  parseReviewEventBegin,
  parseReviewEventChunk,
  parseReviewEventEnd,
  parseReviewEventFrame,
  parseReviewEventFrameName,
  parseReviewEventId,
  ReviewEventAssembler,
  type ReviewEventTypeV1,
} from "../../session/reviewEventProtocol";
import type { HunkReviewPublicationBodyV1 } from "../../session/reviewHttpProtocol";
import { parseReviewPublicationBody, ReviewApiError } from "./apiClient";
import { decodeBase64, webCryptoReviewDigest } from "./webCryptoDigest";

/** One Server-Sent Events record, before any review meaning is given to it. */
export interface ServerSentEventRecord {
  id?: string;
  event: string;
  data: string;
}

/**
 * Split SSE text into records, carrying a partial record across calls.
 *
 * Comment lines (the heartbeat) and records without data are dropped, as the SSE format
 * says; multi-line `data:` fields are joined with newlines.
 */
export class ServerSentEventParser {
  private buffer = "";

  /** Feed decoded text and return every record it completed. */
  push(text: string): ServerSentEventRecord[] {
    this.buffer += text.replace(/\r\n?/g, "\n");
    const records: ServerSentEventRecord[] = [];
    let boundary = this.buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const record = parseRecord(block);
      if (record) {
        records.push(record);
      }
      boundary = this.buffer.indexOf("\n\n");
    }
    return records;
  }
}

/** Parse one SSE block into a record, or nothing for a comment-only block. */
function parseRecord(block: string): ServerSentEventRecord | undefined {
  let id: string | undefined;
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length === 0 ? undefined : { ...(id ? { id } : {}), event, data: data.join("\n") };
}

/** One review event, decoded and verified. */
export type ReviewStreamEvent =
  | { type: "publication"; address: ReviewPublicationAddress; body: HunkReviewPublicationBodyV1 }
  | { type: "disconnect"; address: ReviewPublicationAddress };

/** Refuse one stream that broke the shared contract. */
function protocolError(message: string): ReviewApiError {
  return new ReviewApiError("resource-integrity", message);
}

/**
 * Turn SSE records into review events through the shared contract.
 *
 * Holds at most one chunked event in progress. Anything the contract refuses — an unknown
 * frame name, an envelope that does not parse, a chunk for another event, a payload that
 * does not hash to its declared digest — throws, and the caller ends the stream.
 */
export class ReviewEventDecoder {
  private pending: { type: ReviewEventTypeV1; assembler: ReviewEventAssembler } | undefined;

  constructor(private readonly digest: ReviewAsyncDigestFn = webCryptoReviewDigest) {}

  /** Decode one record, returning an event when the record completes one. */
  async decode(record: ServerSentEventRecord): Promise<ReviewStreamEvent | undefined> {
    const name = parseReviewEventFrameName(record.event);
    if (!name) {
      throw protocolError(`Unknown review event frame ${JSON.stringify(record.event)}.`);
    }
    let data: unknown;
    try {
      data = JSON.parse(record.data);
    } catch {
      throw protocolError("A review event frame was not JSON.");
    }

    if (name.phase === undefined) {
      const frame = parseReviewEventFrame(data);
      if (!frame || this.pending) {
        throw protocolError("A review event frame did not parse.");
      }
      return this.complete(name.type, frame.eventId, record.id, frame.payload);
    }

    if (name.phase === "begin") {
      const begin = parseReviewEventBegin(data);
      if (!begin || this.pending) {
        throw protocolError("A review event began out of order.");
      }
      this.pending = { type: name.type, assembler: new ReviewEventAssembler({ begin }) };
      return undefined;
    }

    if (name.phase === "chunk") {
      const chunk = parseReviewEventChunk(data);
      if (!chunk || !this.pending || this.pending.type !== name.type) {
        throw protocolError("A review event chunk arrived outside its event.");
      }
      const step = this.pending.assembler.accept(chunk, decodeBase64(chunk.data));
      if (!step.ok) {
        throw new ReviewApiError(step.code, step.message);
      }
      return undefined;
    }

    const end = parseReviewEventEnd(data);
    const pending = this.pending;
    this.pending = undefined;
    if (!end || !pending || pending.type !== name.type) {
      throw protocolError("A review event ended outside its event.");
    }
    const assembled = await pending.assembler.finishAsync(end, this.digest);
    if (!assembled.ok) {
      throw new ReviewApiError(assembled.code, assembled.message);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(assembled.bytes));
    } catch {
      throw protocolError("A chunked review event payload was not JSON.");
    }
    return this.complete(name.type, end.eventId, record.id, payload);
  }

  /** Validate one completed event against its id and parse its body. */
  private complete(
    type: ReviewEventTypeV1,
    eventId: string,
    recordId: string | undefined,
    payload: unknown,
  ): ReviewStreamEvent {
    const parsedId = parseReviewEventId(eventId);
    // Only a frame that completes an event carries an id, and it must name this event.
    if (!parsedId || parsedId.type !== type || recordId !== eventId) {
      throw protocolError("A review event carried an id that does not name it.");
    }
    if (type === "disconnect") {
      return { type, address: parsedId.address };
    }
    const body = parseReviewPublicationBody(payload);
    if (
      !body ||
      body.publication.generation !== parsedId.address.generation ||
      body.publication.stateRevision !== parsedId.address.stateRevision
    ) {
      throw protocolError("A review publication event did not match its id.");
    }
    return { type, address: parsedId.address, body };
  }
}

/**
 * Read every review event from one stream body until it ends or the signal aborts.
 *
 * Resolves when the server closes the stream; rejects on a protocol violation. Reading
 * stops after a `disconnect`, which is the server's last word.
 */
export async function readReviewEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ReviewStreamEvent) => void,
  options: { signal?: AbortSignal; digest?: ReviewAsyncDigestFn } = {},
): Promise<void> {
  const reader = body.getReader();
  const text = new TextDecoder();
  const parser = new ServerSentEventParser();
  const decoder = new ReviewEventDecoder(options.digest);
  const abort = () => void reader.cancel().catch(() => undefined);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || options.signal?.aborted) {
        return;
      }
      for (const record of parser.push(text.decode(value, { stream: true }))) {
        const event = await decoder.decode(record);
        if (event) {
          onEvent(event);
          if (event.type === "disconnect") {
            return;
          }
        }
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
  }
}
