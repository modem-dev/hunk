/**
 * Hard size ceilings for everything the session broker parses or stores from the network.
 *
 * The broker is loopback-only by default, but a hostile or buggy local process (and any remote
 * peer when HUNK_MCP_UNSAFE_ALLOW_REMOTE=1) can otherwise stream unbounded HTTP bodies or
 * websocket frames, or register a changeset with an unbounded number of files, hunks, comments,
 * or patch bytes. These caps keep memory bounded while staying far above any realistic review.
 */

/** Maximum decoded byte length accepted for one HTTP API request body. */
export const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;

/** Maximum byte length accepted for one inbound websocket message. */
export const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;

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

// Reused across every websocket message, HTTP body, and patch check to avoid a per-call alloc.
const sharedTextEncoder = new TextEncoder();

/** UTF-8 byte length of a string without allocating a Buffer in non-Node runtimes. */
export function utf8ByteLength(value: string): number {
  return sharedTextEncoder.encode(value).length;
}

/**
 * Read one request body as text while enforcing a hard byte ceiling.
 *
 * The Content-Length header is rejected early when it already declares an oversized body, and the
 * stream is aborted mid-read so a missing or lying Content-Length cannot force the daemon to
 * buffer an unbounded body before the cap is noticed.
 */
export async function readRequestTextWithLimit(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared) {
    const length = Number.parseInt(declared, 10);
    if (Number.isInteger(length) && length > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
  }

  const body = request.body;
  if (!body) {
    // Some runtimes do not expose a streaming body; the Content-Length guard above still bounds
    // well-behaved clients, and the post-read check bounds the rest.
    const text = await request.text();
    if (utf8ByteLength(text) > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }

    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let done: boolean;
    let value: Uint8Array | undefined;
    try {
      const result = await reader.read();
      done = result.done;
      value = result.value;
    } catch (error) {
      reader.releaseLock();
      throw error;
    }

    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    total += value.byteLength;
    if (total > maxBytes) {
      // Stop pulling from the stream immediately so the body cannot grow past the cap.
      await reader.cancel().catch(() => {});
      // cancel() does not release the lock per the Streams spec; release it explicitly so the
      // over-limit path matches the normal-exit path instead of waiting for GC.
      reader.releaseLock();
      throw new PayloadTooLargeError(maxBytes);
    }

    chunks.push(value);
  }

  reader.releaseLock();

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}
