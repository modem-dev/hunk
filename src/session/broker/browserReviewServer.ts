import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseGenerationIdentifier, utf8ByteLength } from "@hunk/session-broker-core";
import { MAX_BROWSER_REVIEW_SNAPSHOT_BYTES, type HunkReviewActionV1 } from "../reviewProtocol";
import {
  HunkSessionBrokerState,
  ReviewGenerationConflictError,
  type HunkSessionObserverEvent,
} from "./state";

const COOKIE_NAME = "hunk_review";
const AUTH_BODY_BYTES = 8 * 1024;
const ACTION_BODY_BYTES = 256 * 1024;
const MAX_JSON_RESPONSE_BYTES = MAX_BROWSER_REVIEW_SNAPSHOT_BYTES;
const MAX_RESOURCE_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_COOKIE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_SSE_CHUNK_BYTES = 32 * 1024;
// Keep even the largest base64 JSON chunk below one 64 KiB SSE frame.
const MAX_SSE_CHUNK_BYTES = 45 * 1024;
// Keep a maximum snapshot inside the default 1,024-frame subscriber count bound.
const MIN_SSE_CHUNK_BYTES = 16 * 1024;
const MAX_SSE_EVENT_ID_BYTES = 256;
// Base64 expands by 4/3; reserve per-frame JSON/SSE metadata above the combined payload bound.
const DEFAULT_SUBSCRIBER_BYTES =
  Math.ceil((MAX_BROWSER_REVIEW_SNAPSHOT_BYTES * 4) / 3) + 2 * 1024 * 1024;
// The eager batch implementation admits four maximum snapshots daemon-wide and closes later slow
// subscribers before retaining more bytes. This remains explicit until a lazy Phase 6 consumer exists.
const DEFAULT_TOTAL_SUBSCRIBER_BYTES = DEFAULT_SUBSCRIBER_BYTES * 4;
const DEFAULT_HISTORY_BYTES = 4 * 1024 * 1024;
const DEFAULT_HISTORY_ENTRY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TOTAL_HISTORY_BYTES = 32 * 1024 * 1024;

const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store, max-age=0",
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "permissions-policy":
    "accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

/** Apply the browser security baseline to a response created outside the route handler. */
export function withBrowserReviewSecurityHeaders(response: Response) {
  const headers = new Headers(SECURITY_HEADERS);
  response.headers.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface BrowserReviewServerOptions {
  cookieTtlMs?: number;
  heartbeatMs?: number;
  maxSubscribers?: number;
  maxSubscribersPerSession?: number;
  maxSubscriberEvents?: number;
  maxSubscriberBytes?: number;
  maxTotalSubscriberBytes?: number;
  maxHistoryEntries?: number;
  maxHistoryBytes?: number;
  maxHistoryEntryBytes?: number;
  maxTotalHistoryBytes?: number;
  sseChunkBytes?: number;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

interface AuthSession {
  sessionId: string;
  capabilityHash: string;
  expiresAt: number;
}

type ReviewEventType = "snapshot" | "document" | "state" | "disconnect";
type BrowserAssetName = "review.html" | "bootstrap.js" | "review.css";

let browserAssetsPromise: Promise<Record<BrowserAssetName, string>> | undefined;

/** Load the large embedded bundle only after a browser asset route is actually requested. */
function loadBrowserAssets() {
  browserAssetsPromise ??= import("../../browser/generated/assets").then(
    (module) => module.EMBEDDED_BROWSER_ASSETS,
  );
  return browserAssetsPromise;
}

interface ReviewEvent {
  id: string;
  type: Exclude<ReviewEventType, "snapshot">;
  data: unknown;
}

interface SseFrame {
  id?: string;
  bytes: Uint8Array;
}

interface SseBatch {
  frames: SseFrame[];
  byteLength: number;
  closeAfterDrain: boolean;
}

interface HistoryEntry extends SseBatch {
  id: string;
  sequence: number;
}

class BrowserReviewBodyTooLargeError extends Error {}

interface Subscriber {
  sessionId: string;
  capabilityHash: string;
  expiresAt: number;
  controller: ReadableStreamDefaultController<Uint8Array>;
  queue: SseFrame[];
  bufferedBytes: number;
  controllerBytes: number;
  closeAfterDrain: boolean;
  closed: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

/** Add browser-review authentication, assets, API, and observer SSE above Hunk broker state. */
export class BrowserReviewServer {
  private readonly authSessions = new Map<string, AuthSession>();
  private readonly eventsBySession = new Map<string, HistoryEntry[]>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly encoder = new TextEncoder();
  private readonly now: () => number;
  private readonly cookieTtlMs: number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private totalSubscriberBytes = 0;
  private totalHistoryBytes = 0;
  private historySequence = 0;
  private closed = false;

  constructor(
    private readonly state: HunkSessionBrokerState,
    private readonly options: BrowserReviewServerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.cookieTtlMs = options.cookieTtlMs ?? DEFAULT_COOKIE_TTL_MS;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
    this.unsubscribe = state.subscribeReviewEvents((event) => this.observe(event));
    this.heartbeat = setInterval(
      () => this.broadcastHeartbeat(),
      options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    );
    this.heartbeat.unref?.();
  }

  /** Handle only the closed set of Hunk browser-review routes. */
  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const requestOriginError = this.validateRequestOrigin(request);
    if (requestOriginError) return requestOriginError;
    if (url.pathname === "/review-auth") return this.handleAuth(request);

    const asset = this.parseAssetPath(url.pathname);
    if (asset) return this.handleAsset(request, asset.sessionId, asset.name);

    const api = this.parseApiPath(url.pathname);
    if (!api) {
      return url.pathname.startsWith("/review-api/")
        ? this.jsonError("Invalid browser review API path.", 400)
        : undefined;
    }
    const authentication = this.authenticate(request, api.sessionId);
    if (!authentication) return this.jsonError("Review authorization is missing or expired.", 401);

    switch (api.kind) {
      case "snapshot":
        return request.method === "GET"
          ? this.json(this.state.getBrowserReviewSnapshot(api.sessionId))
          : this.methodNotAllowed("GET");
      case "events":
        return request.method === "GET"
          ? this.openEventStream(request, api.sessionId, authentication)
          : this.methodNotAllowed("GET");
      case "resource":
        return request.method === "GET"
          ? this.handleResource(request, api.sessionId, api.generation, api.resourceId)
          : this.methodNotAllowed("GET");
      case "actions":
        return request.method === "POST"
          ? this.handleAction(request, api.sessionId)
          : this.methodNotAllowed("POST");
    }
  }

  /** Expose live observer count for bounded lifecycle tests and daemon diagnostics. */
  getSubscriberCount() {
    return this.subscribers.size;
  }

  /** Expose aggregate queued and controller-buffered SSE bytes for bounded tests. */
  getSubscriberBufferedByteCount() {
    return this.totalSubscriberBytes;
  }

  /** Expose retained semantic event count for history-pruning tests. */
  getHistoryEntryCount(sessionId: string) {
    return this.eventsBySession.get(sessionId)?.length ?? 0;
  }

  /** Close observers, timers, authentication records, and every pending SSE stream. */
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.unsubscribe();
    this.authSessions.clear();
    this.eventsBySession.clear();
    this.totalHistoryBytes = 0;
    for (const subscriber of Array.from(this.subscribers)) this.closeSubscriber(subscriber);
  }

  private headers(extra: HeadersInit = {}) {
    const headers = new Headers(SECURITY_HEADERS);
    const additions = new Headers(extra);
    additions.forEach((value, key) => headers.set(key, value));
    return headers;
  }

  private json(value: unknown, init: ResponseInit = {}): Response {
    const text = JSON.stringify(value);
    if (utf8ByteLength(text) > MAX_JSON_RESPONSE_BYTES) {
      return this.jsonError("Review response exceeds the browser response limit.", 507);
    }
    return new Response(text, {
      ...init,
      headers: this.headers({ "content-type": "application/json; charset=utf-8", ...init.headers }),
    });
  }

  private jsonError(
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ): Response {
    return this.json({ error: message, ...details }, { status });
  }

  private methodNotAllowed(method: string) {
    return this.jsonError(`Review route requires ${method}.`, 405, { allowed: method });
  }

  private parseAssetPath(pathname: string) {
    const match = pathname.match(/^\/review\/([^/]+)\/(|bootstrap\.js|review\.css)$/);
    if (!match) return null;
    const sessionId = this.decodeSegment(match[1]!);
    if (!sessionId) return null;
    const name = (match[2] || "review.html") as BrowserAssetName;
    return { sessionId, name };
  }

  private parseApiPath(
    pathname: string,
  ):
    | { sessionId: string; kind: "snapshot" | "events" | "actions" }
    | { sessionId: string; kind: "resource"; generation: string; resourceId: string }
    | null {
    const parts = pathname.split("/");
    if (parts[0] !== "" || parts[1] !== "review-api") return null;
    const sessionId = this.decodeSegment(parts[2]);
    if (!sessionId) return null;
    if (parts.length === 4 && ["snapshot", "events", "actions"].includes(parts[3]!)) {
      return { sessionId, kind: parts[3] as "snapshot" | "events" | "actions" };
    }
    if (parts.length === 6 && parts[3] === "resources") {
      const generation = parseGenerationIdentifier(this.decodeSegment(parts[4]));
      const resourceId = this.decodeSegment(parts[5]);
      if (generation && resourceId) {
        return { sessionId, kind: "resource", generation, resourceId };
      }
    }
    return null;
  }

  private decodeSegment(value: string | undefined) {
    if (!value || value.length > 1024) return null;
    try {
      const decoded = decodeURIComponent(value);
      return decoded && !decoded.includes("/") && !decoded.includes("\\") ? decoded : null;
    } catch {
      return null;
    }
  }

  private async handleAsset(request: Request, sessionId: string, name: BrowserAssetName) {
    if (request.method !== "GET") return this.methodNotAllowed("GET");
    if (!this.state.getBrowserReviewCapabilityHash(sessionId)) {
      return this.jsonError("The review session is not available for browser review.", 404);
    }
    const assets = await loadBrowserAssets();
    const contentType =
      name === "review.html"
        ? "text/html; charset=utf-8"
        : name === "bootstrap.js"
          ? "text/javascript; charset=utf-8"
          : "text/css; charset=utf-8";
    if (name === "review.html") {
      const nonce = randomBytes(18).toString("base64");
      const html = assets[name].replace("__HUNK_REVIEW_NONCE__", nonce);
      return new Response(html, {
        headers: this.headers({
          "content-type": contentType,
          "content-security-policy": CONTENT_SECURITY_POLICY.replace(
            "script-src 'self'",
            `script-src 'nonce-${nonce}'`,
          ),
        }),
      });
    }
    return new Response(assets[name], {
      headers: this.headers({ "content-type": contentType }),
    });
  }

  private async handleAuth(request: Request) {
    if (request.method !== "POST") return this.methodNotAllowed("POST");
    const originError = this.validatePostOrigin(request);
    if (originError) return originError;
    if (!this.hasJsonContentType(request)) return this.jsonError("Expected JSON.", 415);
    let value: unknown;
    try {
      value = await this.readJson(request, AUTH_BODY_BYTES);
    } catch (error) {
      return this.jsonError(
        error instanceof Error ? error.message : "Invalid JSON.",
        error instanceof BrowserReviewBodyTooLargeError ? 413 : 400,
      );
    }
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    if (
      !record ||
      Object.keys(record).length !== 2 ||
      typeof record.sessionId !== "string" ||
      typeof record.capability !== "string" ||
      record.capability.length > 256
    )
      return this.jsonError("Invalid review authorization request.", 400);

    const expected = this.state.getBrowserReviewCapabilityHash(record.sessionId);
    const actual = createHash("sha256").update(record.capability, "utf8").digest();
    const expectedBytes =
      expected && /^[a-f\d]{64}$/.test(expected) ? Buffer.from(expected, "hex") : randomBytes(32);
    if (!timingSafeEqual(actual, expectedBytes) || !expected) {
      return this.jsonError("Review authorization failed.", 401);
    }

    this.pruneAuth();
    while (this.authSessions.size >= 256)
      this.authSessions.delete(this.authSessions.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    this.authSessions.set(this.tokenKey(token), {
      sessionId: record.sessionId,
      capabilityHash: expected,
      expiresAt: this.now() + this.cookieTtlMs,
    });
    const path = `/review-api/${encodeURIComponent(record.sessionId)}/`;
    const cookie = [
      `${COOKIE_NAME}=${token}`,
      `Path=${path}`,
      `Max-Age=${Math.max(1, Math.floor(this.cookieTtlMs / 1000))}`,
      "HttpOnly",
      "SameSite=Strict",
      ...(new URL(request.url).protocol === "https:" ? ["Secure"] : []),
    ].join("; ");
    return this.json(
      { ok: true, sessionId: record.sessionId },
      { headers: { "set-cookie": cookie } },
    );
  }

  private authenticate(request: Request, sessionId: string) {
    this.pruneAuth();
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`));
    const token = cookie?.slice(COOKIE_NAME.length + 1);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const auth = this.authSessions.get(this.tokenKey(token));
    return auth &&
      auth.expiresAt > this.now() &&
      auth.sessionId === sessionId &&
      auth.capabilityHash === this.state.getBrowserReviewCapabilityHash(sessionId)
      ? auth
      : null;
  }

  private tokenKey(token: string) {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  private pruneAuth() {
    const now = this.now();
    for (const [key, auth] of this.authSessions) {
      if (
        auth.expiresAt <= now ||
        this.state.getBrowserReviewCapabilityHash(auth.sessionId) !== auth.capabilityHash
      ) {
        this.authSessions.delete(key);
      }
    }
  }

  private hasJsonContentType(request: Request) {
    return (
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
      "application/json"
    );
  }

  private validateRequestOrigin(request: Request) {
    const origin = request.headers.get("origin");
    if (!origin) return null;
    const host = request.headers.get("host");
    const protocol = new URL(request.url).protocol;
    return host && origin === `${protocol}//${host}`
      ? null
      : this.jsonError("Origin is not allowed for browser review.", 403);
  }

  private validatePostOrigin(request: Request) {
    if (!request.headers.get("origin")) {
      return this.jsonError("Origin is required for browser review posts.", 403);
    }
    return this.validateRequestOrigin(request);
  }

  private async readJson(request: Request, limit: number) {
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit)
      throw new BrowserReviewBodyTooLargeError("Review request body is too large.");
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Expected one JSON request body.");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new BrowserReviewBodyTooLargeError("Review request body is too large.");
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("Expected one JSON request body.");
    }
  }

  private async handleResource(
    request: Request,
    sessionId: string,
    generation: string,
    resourceId: string,
  ) {
    try {
      const { descriptor, bytes } = await this.state.getBrowserReviewResource(
        sessionId,
        generation,
        resourceId,
      );
      const range = this.parseRange(request.headers.get("range"), bytes.byteLength);
      if (range === "invalid") {
        return new Response(null, {
          status: 416,
          headers: this.headers({ "content-range": `bytes */${bytes.byteLength}` }),
        });
      }
      const start = range?.start ?? 0;
      const requestedEnd = range?.end ?? bytes.byteLength - 1;
      const end = Math.min(requestedEnd, start + MAX_RESOURCE_RESPONSE_BYTES - 1);
      const partial = Boolean(range) || start !== 0 || end !== bytes.byteLength - 1;
      return new Response(bytes.slice(start, end + 1), {
        status: partial ? 206 : 200,
        headers: this.headers({
          "accept-ranges": "bytes",
          "content-length": String(Math.max(0, end - start + 1)),
          "content-type": descriptor.contentType,
          ...(partial ? { "content-range": `bytes ${start}-${end}/${bytes.byteLength}` } : {}),
        }),
      });
    } catch (error) {
      if (error instanceof ReviewGenerationConflictError) {
        return this.jsonError(error.message, 409, {
          code: error.code,
          currentGeneration: error.currentGeneration,
        });
      }
      return this.jsonError(error instanceof Error ? error.message : "Resource read failed.", 404);
    }
  }

  private parseRange(
    header: string | null,
    size: number,
  ): { start: number; end: number } | "invalid" | null {
    if (!header) return null;
    const match = header.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) return "invalid";
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : size - 1;
    return Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      start >= 0 &&
      start <= end &&
      start < size
      ? { start, end: Math.min(end, size - 1) }
      : "invalid";
  }

  private async handleAction(request: Request, sessionId: string) {
    const originError = this.validatePostOrigin(request);
    if (originError) return originError;
    if (!this.hasJsonContentType(request)) return this.jsonError("Expected JSON.", 415);
    let value: unknown;
    try {
      value = await this.readJson(request, ACTION_BODY_BYTES);
    } catch (error) {
      return this.jsonError(
        error instanceof Error ? error.message : "Invalid JSON.",
        error instanceof BrowserReviewBodyTooLargeError ? 413 : 400,
      );
    }
    const record =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    const generation = parseGenerationIdentifier(record?.generation);
    const expectedStateRevision = record?.expectedStateRevision;
    if (
      !record ||
      ![2, 3].includes(Object.keys(record).length) ||
      Object.keys(record).some(
        (key) => !["generation", "expectedStateRevision", "action"].includes(key),
      ) ||
      !generation ||
      (expectedStateRevision !== undefined &&
        (!Number.isSafeInteger(expectedStateRevision) || (expectedStateRevision as number) < 0)) ||
      !("action" in record)
    ) {
      return this.jsonError("Invalid review action envelope.", 400);
    }
    try {
      const result = await this.state.applyBrowserReviewAction(
        sessionId,
        generation,
        record.action as HunkReviewActionV1,
        expectedStateRevision as number | undefined,
      );
      if (result.kind === "review-error") {
        const status =
          result.error.code === "stale-generation" || result.error.code === "stale-revision"
            ? 409
            : 400;
        return this.json(result, { status });
      }
      return this.json(result);
    } catch (error) {
      if (error instanceof ReviewGenerationConflictError) {
        return this.jsonError(error.message, 409, {
          code: error.code,
          currentGeneration: error.currentGeneration,
        });
      }
      return this.jsonError(error instanceof Error ? error.message : "Review action failed.", 400);
    }
  }

  /** Build a compact opaque event id without copying producer generation text into SSE frames. */
  private eventId(generation: string, revision: number, type: "document" | "state") {
    const generationKey = createHash("sha256").update(generation).digest("hex").slice(0, 32);
    return `v1.${generationKey}.${revision}.${type}`;
  }

  /** Accept only bounded single-line identifiers in the browser-controlled replay header. */
  private isSseEventId(value: string) {
    return (
      utf8ByteLength(value) <= MAX_SSE_EVENT_ID_BYTES && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    );
  }

  /** Translate one broker mirror observation without consulting the producer socket. */
  private observe(event: HunkSessionObserverEvent) {
    if (event.type === "disconnect") {
      const frame = this.eventBatch(`disconnect.${this.now()}`, "disconnect", {
        sessionId: event.sessionId,
      }).frames[0]!;
      for (const subscriber of Array.from(this.subscribers)) {
        if (subscriber.sessionId !== event.sessionId) continue;
        if (subscriber.expiresAt <= this.now()) this.closeSubscriber(subscriber);
        else this.sendFinalFrameAndClose(subscriber, frame);
      }
      for (const [key, auth] of this.authSessions) {
        if (auth.sessionId === event.sessionId) this.authSessions.delete(key);
      }
      const retiredHistory = this.eventsBySession.get(event.sessionId) ?? [];
      this.totalHistoryBytes -= retiredHistory.reduce((sum, entry) => sum + entry.byteLength, 0);
      this.eventsBySession.delete(event.sessionId);
      return;
    }
    try {
      const snapshot = this.state.getBrowserReviewSnapshot(event.sessionId);
      const type = event.type === "state-revision" ? "state" : "document";
      const data =
        type === "state" ? { generation: snapshot.generation, state: snapshot.state } : snapshot;
      this.pushEvent(event.sessionId, {
        id: this.eventId(snapshot.generation, snapshot.state.stateRevision, type),
        type,
        data,
      });
    } catch {
      // A concurrent retirement is represented by the subsequent disconnect/document event.
    }
  }

  /** Encode one SSE frame with an optional reconnect id. */
  private frame(id: string | undefined, type: string, data: unknown): SseFrame {
    const text = `${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    return { id, bytes: this.encoder.encode(text) };
  }

  /** Measure one ASCII-metadata SSE frame without allocating its encoded byte buffer. */
  private frameByteLength(id: string, type: string, jsonByteLength: number) {
    return 4 + id.length + 1 + 7 + type.length + 1 + 6 + jsonByteLength + 2;
  }

  /** Compute the exact encoded chunk-batch size before allocating any frame byte arrays. */
  private chunkedBatchByteLength(
    id: string,
    type: ReviewEventType,
    payloadByteLength: number,
    chunkBytes: number,
  ) {
    const chunkCount = Math.ceil(payloadByteLength / chunkBytes);
    const digest = "0".repeat(64);
    const beginJson = JSON.stringify({
      id,
      encoding: "base64",
      byteLength: payloadByteLength,
      chunkCount,
      digest,
    });
    const endJson = JSON.stringify({ id, byteLength: payloadByteLength, chunkCount, digest });
    let byteLength =
      this.frameByteLength(`${id}.begin`, `${type}-begin`, beginJson.length) +
      this.frameByteLength(`${id}.end`, `${type}-end`, endJson.length);
    for (let index = 0; index < chunkCount; index += 1) {
      const rawBytes = Math.min(chunkBytes, payloadByteLength - index * chunkBytes);
      const base64Bytes = 4 * Math.ceil(rawBytes / 3);
      const emptyChunkJson = JSON.stringify({ id, index, data: "" });
      byteLength += this.frameByteLength(
        `${id}.chunk.${index}`,
        `${type}-chunk`,
        emptyChunkJson.length + base64Bytes,
      );
    }
    return { byteLength, chunkCount };
  }

  /** Split a bounded semantic payload into deterministic reconstructable SSE frames. */
  private eventBatch(id: string, type: ReviewEventType, data: unknown): SseBatch {
    if (!this.isSseEventId(id)) throw new Error("Review SSE event identifier is invalid.");
    const serialized = JSON.stringify(data);
    const payloadByteLength = utf8ByteLength(serialized);
    if (payloadByteLength > MAX_BROWSER_REVIEW_SNAPSHOT_BYTES) {
      throw new Error("Review SSE payload exceeds the combined browser snapshot limit.");
    }
    const chunkBytes = Math.min(
      MAX_SSE_CHUNK_BYTES,
      Math.max(MIN_SSE_CHUNK_BYTES, this.options.sseChunkBytes ?? DEFAULT_SSE_CHUNK_BYTES),
    );
    if (payloadByteLength <= chunkBytes) {
      const measuredBytes = this.frameByteLength(id, type, payloadByteLength);
      if (measuredBytes > DEFAULT_SUBSCRIBER_BYTES) {
        throw new Error("Review SSE batch exceeds the bounded stream allocation limit.");
      }
      const frame = this.frame(id, type, data);
      return {
        frames: [frame],
        byteLength: frame.bytes.byteLength,
        closeAfterDrain: type === "disconnect",
      };
    }

    const measured = this.chunkedBatchByteLength(id, type, payloadByteLength, chunkBytes);
    if (measured.byteLength > DEFAULT_SUBSCRIBER_BYTES) {
      throw new Error("Review SSE batch exceeds the bounded stream allocation limit.");
    }

    // The exact full-batch preflight above occurs before payload and frame byte allocations.
    const payload = Buffer.from(serialized, "utf8");
    const digest = createHash("sha256").update(payload).digest("hex");
    const begin = this.frame(`${id}.begin`, `${type}-begin`, {
      id,
      encoding: "base64",
      byteLength: payload.byteLength,
      chunkCount: measured.chunkCount,
      digest,
    });
    const frames = [begin];
    for (let index = 0; index < measured.chunkCount; index += 1) {
      const start = index * chunkBytes;
      frames.push(
        this.frame(`${id}.chunk.${index}`, `${type}-chunk`, {
          id,
          index,
          data: payload.subarray(start, start + chunkBytes).toString("base64"),
        }),
      );
    }
    frames.push(
      this.frame(`${id}.end`, `${type}-end`, {
        id,
        byteLength: payload.byteLength,
        chunkCount: measured.chunkCount,
        digest,
      }),
    );
    const allocatedByteLength = frames.reduce((sum, frame) => sum + frame.bytes.byteLength, 0);
    if (allocatedByteLength !== measured.byteLength) {
      throw new Error("Review SSE batch preflight did not match its allocated frame size.");
    }
    return {
      frames,
      byteLength: allocatedByteLength,
      closeAfterDrain: type === "disconnect",
    };
  }

  /** Retain only complete bounded semantic event batches for reconnect recovery. */
  private retainHistory(sessionId: string, id: string, batch: SseBatch) {
    const maxEntryBytes = this.options.maxHistoryEntryBytes ?? DEFAULT_HISTORY_ENTRY_BYTES;
    if (batch.byteLength > maxEntryBytes) return;
    const history = this.eventsBySession.get(sessionId) ?? [];
    history.push({ id, sequence: ++this.historySequence, ...batch });
    this.totalHistoryBytes += batch.byteLength;
    const maxEntries = this.options.maxHistoryEntries ?? 128;
    const maxBytes = this.options.maxHistoryBytes ?? DEFAULT_HISTORY_BYTES;
    let bytes = history.reduce((sum, entry) => sum + entry.byteLength, 0);
    while (history.length > maxEntries || bytes > maxBytes) {
      const removed = history.shift()!;
      bytes -= removed.byteLength;
      this.totalHistoryBytes -= removed.byteLength;
    }
    if (history.length > 0) this.eventsBySession.set(sessionId, history);
    else this.eventsBySession.delete(sessionId);
    this.pruneGlobalHistory();
  }

  /** Enforce one daemon-wide history budget by evicting the oldest complete batch. */
  private pruneGlobalHistory() {
    const limit = this.options.maxTotalHistoryBytes ?? DEFAULT_TOTAL_HISTORY_BYTES;
    while (this.totalHistoryBytes > limit) {
      let oldestSession: string | undefined;
      let oldest: HistoryEntry | undefined;
      for (const [sessionId, history] of this.eventsBySession) {
        const candidate = history[0];
        if (candidate && (!oldest || candidate.sequence < oldest.sequence)) {
          oldest = candidate;
          oldestSession = sessionId;
        }
      }
      if (!oldest || !oldestSession) break;
      const history = this.eventsBySession.get(oldestSession)!;
      history.shift();
      this.totalHistoryBytes -= oldest.byteLength;
      if (history.length === 0) this.eventsBySession.delete(oldestSession);
    }
  }

  /** Retain and fan out one semantic event under auth and byte bounds. */
  private pushEvent(sessionId: string, event: ReviewEvent) {
    const batch = this.eventBatch(event.id, event.type, event.data);
    this.retainHistory(sessionId, event.id, batch);
    for (const subscriber of Array.from(this.subscribers)) {
      if (subscriber.sessionId !== sessionId) continue;
      this.enqueueFrames(subscriber, batch.frames, batch.closeAfterDrain);
    }
  }

  /** Resolve replay frames after a Last-Event-ID, or signal full-snapshot fallback. */
  private replayFrames(sessionId: string, lastId: string) {
    const history = this.eventsBySession.get(sessionId) ?? [];
    for (let entryIndex = 0; entryIndex < history.length; entryIndex += 1) {
      const entry = history[entryIndex]!;
      const frameIndex = entry.frames.findIndex((frame) => frame.id === lastId);
      if (frameIndex < 0) continue;
      return [
        ...entry.frames.slice(frameIndex + 1),
        ...history.slice(entryIndex + 1).flatMap((candidate) => candidate.frames),
      ];
    }
    return null;
  }

  /** Open one bounded observer stream with replay or chunked full-snapshot recovery. */
  private openEventStream(request: Request, sessionId: string, auth: AuthSession) {
    const lastId = request.headers.get("last-event-id");
    if (lastId && !this.isSseEventId(lastId)) {
      return this.jsonError("Last-Event-ID is invalid.", 400);
    }
    if (
      this.subscribers.size >= (this.options.maxSubscribers ?? 128) ||
      [...this.subscribers].filter((subscriber) => subscriber.sessionId === sessionId).length >=
        (this.options.maxSubscribersPerSession ?? 16)
    ) {
      return this.jsonError("Review event subscriber limit reached.", 503);
    }
    const current = this.state.getBrowserReviewSnapshot(sessionId);
    let subscriber!: Subscriber;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          subscriber = {
            sessionId,
            capabilityHash: auth.capabilityHash,
            expiresAt: auth.expiresAt,
            controller,
            queue: [],
            bufferedBytes: 0,
            controllerBytes: 0,
            closeAfterDrain: false,
            closed: false,
          };
          this.subscribers.add(subscriber);
          this.scheduleSubscriberExpiry(subscriber);
          const replay = lastId ? this.replayFrames(sessionId, lastId) : null;
          if (replay !== null) {
            this.enqueueFrames(subscriber, replay);
          } else {
            const id = `${this.eventId(
              current.generation,
              current.state.stateRevision,
              "document",
            )}.snapshot`;
            const snapshot = this.eventBatch(id, "snapshot", current);
            // Initial/fallback snapshots are connection-local and never duplicate semantic history.
            this.enqueueFrames(subscriber, snapshot.frames);
          }
        },
        pull: () => this.flushSubscriber(subscriber),
        cancel: () => this.removeSubscriber(subscriber),
      },
      { highWaterMark: 1 },
    );
    if (request.signal.aborted) this.closeSubscriber(subscriber);
    else {
      request.signal.addEventListener("abort", () => this.closeSubscriber(subscriber), {
        once: true,
      });
    }
    return new Response(stream, {
      headers: this.headers({
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      }),
    });
  }

  /** Close one stream at cookie expiry even when no review events occur. */
  private scheduleSubscriberExpiry(subscriber: Subscriber) {
    const delay = Math.max(1, subscriber.expiresAt - this.now());
    subscriber.expiryTimer = this.setTimeoutImpl(() => {
      if (this.revalidateSubscriber(subscriber)) this.scheduleSubscriberExpiry(subscriber);
    }, delay);
    subscriber.expiryTimer.unref?.();
  }

  /** Revalidate expiry, session retirement, and capability rotation for an open stream. */
  private revalidateSubscriber(subscriber: Subscriber) {
    const valid =
      !subscriber.closed &&
      subscriber.expiresAt > this.now() &&
      this.state.getBrowserReviewCapabilityHash(subscriber.sessionId) === subscriber.capabilityHash;
    if (!valid && !subscriber.closed) this.closeSubscriber(subscriber);
    return valid;
  }

  /** Queue frames atomically under per-subscriber and daemon-wide byte budgets. */
  private enqueueFrames(subscriber: Subscriber, frames: SseFrame[], closeAfterDrain = false) {
    if (!this.revalidateSubscriber(subscriber) || frames.length === 0) return;
    const bytes = frames.reduce((sum, frame) => sum + frame.bytes.byteLength, 0);
    const maxSubscriberBytes = this.options.maxSubscriberBytes ?? DEFAULT_SUBSCRIBER_BYTES;
    const maxTotalBytes = this.options.maxTotalSubscriberBytes ?? DEFAULT_TOTAL_SUBSCRIBER_BYTES;
    if (
      subscriber.queue.length + frames.length + (subscriber.controllerBytes > 0 ? 1 : 0) >
        (this.options.maxSubscriberEvents ?? 1024) ||
      subscriber.bufferedBytes + bytes > maxSubscriberBytes ||
      this.totalSubscriberBytes + bytes > maxTotalBytes
    ) {
      this.closeSubscriber(subscriber, new Error("Review event subscriber is too slow."));
      return;
    }
    subscriber.queue.push(...frames);
    subscriber.bufferedBytes += bytes;
    this.totalSubscriberBytes += bytes;
    subscriber.closeAfterDrain ||= closeAfterDrain;
  }

  /** Account for one frame consumed from the ReadableStream controller. */
  private consumeControllerFrame(subscriber: Subscriber) {
    if (subscriber.controllerBytes === 0) return;
    subscriber.bufferedBytes -= subscriber.controllerBytes;
    this.totalSubscriberBytes -= subscriber.controllerBytes;
    subscriber.controllerBytes = 0;
  }

  /** Move one queued frame into the controller while retaining byte accounting. */
  private flushSubscriber(subscriber: Subscriber) {
    if (!this.revalidateSubscriber(subscriber)) return;
    this.consumeControllerFrame(subscriber);
    const next = subscriber.queue.shift();
    if (next) {
      subscriber.controllerBytes = next.bytes.byteLength;
      try {
        subscriber.controller.enqueue(next.bytes);
      } catch (error) {
        this.closeSubscriber(
          subscriber,
          error instanceof Error ? error : new Error("Review event stream failed."),
        );
        return;
      }
    }
    if (subscriber.closeAfterDrain && subscriber.queue.length === 0 && !next) {
      this.closeSubscriber(subscriber);
    }
  }

  /** Revalidate every stream before sending one bounded heartbeat frame. */
  private broadcastHeartbeat() {
    const heartbeat = { bytes: this.encoder.encode(": heartbeat\n\n") } satisfies SseFrame;
    for (const subscriber of Array.from(this.subscribers)) {
      this.enqueueFrames(subscriber, [heartbeat]);
    }
  }

  /** Release timers plus queue and controller byte accounting exactly once. */
  private removeSubscriber(subscriber: Subscriber) {
    if (!subscriber || subscriber.closed) return;
    subscriber.closed = true;
    if (subscriber.expiryTimer) this.clearTimeoutImpl(subscriber.expiryTimer);
    this.totalSubscriberBytes -= subscriber.bufferedBytes;
    subscriber.bufferedBytes = 0;
    subscriber.controllerBytes = 0;
    subscriber.queue.length = 0;
    this.subscribers.delete(subscriber);
  }

  /** Deliver one terminal control frame while releasing all retained subscriber state. */
  private sendFinalFrameAndClose(subscriber: Subscriber, frame: SseFrame) {
    if (subscriber.closed) return;
    this.removeSubscriber(subscriber);
    try {
      subscriber.controller.enqueue(frame.bytes);
      subscriber.controller.close();
    } catch {
      /* already closed */
    }
  }

  /** Close one subscriber, optionally surfacing a slow-client failure. */
  private closeSubscriber(subscriber: Subscriber, error?: Error) {
    if (!subscriber || subscriber.closed) return;
    this.removeSubscriber(subscriber);
    try {
      if (error) subscriber.controller.error(error);
      else subscriber.controller.close();
    } catch {
      /* already closed */
    }
  }
}
