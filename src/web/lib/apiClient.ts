import type { ReviewResourceDescriptorV1 } from "../../core/review/types";
import type { HunkReviewActionV1, ReviewActionResult } from "../../session/reviewProtocol";
import { ReviewSseChunks, sha256, type ReviewMirrorEvent } from "./mirror";
import type { BrowserReviewSnapshot } from "./reviewTypes";

const RESOURCE_RANGE_BYTES = 256 * 1024;

export class BrowserReviewApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly currentGeneration?: string,
  ) {
    super(message);
  }
}

/** Typed conflict returned when the browser mirror must reconcile before retrying. */
export class BrowserReviewConflictError extends BrowserReviewApiError {}

interface QueuedResource {
  generation: string;
  key: string;
  run: () => void;
  reject: (error: Error) => void;
}

/** Authenticated client for the closed browser-review route set. */
export class BrowserReviewApiClient {
  private readonly base: string;
  private readonly resourceQueue: QueuedResource[] = [];
  private readonly resourceControllers = new Map<string, Set<AbortController>>();
  private readonly resourceCache = new Map<string, Promise<string>>();
  private resourceActive = 0;
  private currentGeneration?: string;

  constructor(
    readonly sessionId: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.base = `/review-api/${encodeURIComponent(sessionId)}`;
  }

  static async authenticate(sessionId: string, capability: string) {
    const response = await fetch("/review-auth", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, capability }),
    });
    if (!response.ok)
      throw new BrowserReviewApiError("Local review authorization failed.", response.status);
    return new BrowserReviewApiClient(sessionId);
  }

  async snapshot() {
    return this.json<BrowserReviewSnapshot>(`${this.base}/snapshot`);
  }

  /** Apply one semantic action with the mirror generation and revision preconditions. */
  async action(generation: string, expectedStateRevision: number, action: HunkReviewActionV1) {
    const response = await this.fetchImpl(`${this.base}/actions`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation, expectedStateRevision, action }),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    const record =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
    const commandError =
      record?.kind === "review-error" && record.error && typeof record.error === "object"
        ? (record.error as Record<string, unknown>)
        : null;
    const routeError = typeof record?.error === "string" ? record : null;
    if (!response.ok || commandError) {
      const details = commandError ?? routeError;
      const message =
        typeof details?.message === "string"
          ? details.message
          : typeof details?.error === "string"
            ? details.error
            : response.status === 409
              ? "The review changed before this action was applied."
              : "The review action was rejected.";
      const ErrorType =
        response.status === 409 ? BrowserReviewConflictError : BrowserReviewApiError;
      throw new ErrorType(
        message,
        response.status,
        typeof details?.code === "string" ? details.code : undefined,
        typeof details?.currentGeneration === "string" ? details.currentGeneration : undefined,
      );
    }
    return payload as ReviewActionResult;
  }

  /** Abort obsolete queued/inflight resources and retain only the active generation cache. */
  replaceGeneration(generation: string) {
    if (this.currentGeneration === generation) return;
    this.currentGeneration = generation;
    for (const [candidate, controllers] of this.resourceControllers) {
      if (candidate !== generation) for (const controller of controllers) controller.abort();
    }
    for (let index = this.resourceQueue.length - 1; index >= 0; index -= 1) {
      const queued = this.resourceQueue[index]!;
      if (queued.generation === generation) continue;
      this.resourceQueue.splice(index, 1);
      queued.reject(new DOMException("Obsolete review generation.", "AbortError"));
    }
    for (const key of this.resourceCache.keys()) {
      if (!key.startsWith(`${generation}\0`)) this.resourceCache.delete(key);
    }
  }

  /** Fetch and verify one cached resource through an abortable bounded queue. */
  resource(
    generation: string,
    descriptor: ReviewResourceDescriptorV1,
    signal?: AbortSignal,
  ): Promise<string> {
    const key = `${generation}\0${descriptor.id}`;
    const cached = this.resourceCache.get(key);
    if (cached) return cached;
    const promise = new Promise<string>((resolve, reject) => {
      const queued: QueuedResource = {
        generation,
        key,
        reject,
        run: () => {
          if (
            signal?.aborted ||
            (this.currentGeneration && generation !== this.currentGeneration)
          ) {
            reject(new DOMException("Obsolete review resource.", "AbortError"));
            return;
          }
          const controller = new AbortController();
          const controllers = this.resourceControllers.get(generation) ?? new Set();
          controllers.add(controller);
          this.resourceControllers.set(generation, controllers);
          const abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          this.resourceActive += 1;
          void this.fetchResource(generation, descriptor, controller.signal)
            .then(resolve, reject)
            .finally(() => {
              signal?.removeEventListener("abort", abort);
              controllers.delete(controller);
              if (controllers.size === 0) this.resourceControllers.delete(generation);
              this.resourceActive -= 1;
              this.pumpResourceQueue();
            });
        },
      };
      this.resourceQueue.push(queued);
      this.pumpResourceQueue();
    });
    this.resourceCache.set(key, promise);
    void promise.catch(() => {
      if (this.resourceCache.get(key) === promise) this.resourceCache.delete(key);
    });
    return promise;
  }

  /** Release one off-window resource so canonical text is not retained for the whole review. */
  releaseResource(generation: string, resourceId: string) {
    const key = `${generation}\0${resourceId}`;
    this.resourceCache.delete(key);
    for (let index = this.resourceQueue.length - 1; index >= 0; index -= 1) {
      const queued = this.resourceQueue[index]!;
      if (queued.key !== key) continue;
      this.resourceQueue.splice(index, 1);
      queued.reject(new DOMException("Review resource left the render window.", "AbortError"));
    }
  }

  /** Observe full semantic events; EventSource owns Last-Event-ID reconnect replay. */
  events(callbacks: {
    onEvent: (event: ReviewMirrorEvent) => void | Promise<void>;
    onOpen: () => void;
    onError: (status?: number) => void;
    onMalformed: () => void | Promise<void>;
  }) {
    const source = new EventSource(`${this.base}/events`, { withCredentials: true });
    const chunks = new ReviewSseChunks(callbacks.onEvent, callbacks.onMalformed);
    let eventQueue = Promise.resolve();
    const types = ["snapshot", "document", "state", "disconnect"] as const;
    for (const type of types) {
      for (const eventType of [type, `${type}-begin`, `${type}-chunk`, `${type}-end`]) {
        source.addEventListener(eventType, (event) => {
          const message = event as MessageEvent<string>;
          eventQueue = eventQueue.then(async () => {
            try {
              await chunks.accept(eventType, JSON.parse(message.data));
            } catch {
              await callbacks.onMalformed();
            }
          });
        });
      }
    }
    source.onopen = callbacks.onOpen;
    source.onerror = () => {
      // Close the mutation gate synchronously; status probing must never leave a stale write window.
      callbacks.onError();
      void this.probeStatus().then(
        (status) => {
          if (status !== undefined) callbacks.onError(status);
        },
        () => {},
      );
    };
    return () => source.close();
  }

  private pumpResourceQueue() {
    while (this.resourceActive < 6 && this.resourceQueue.length > 0) {
      this.resourceQueue.shift()!.run();
    }
  }

  private async fetchResource(
    generation: string,
    descriptor: ReviewResourceDescriptorV1,
    signal: AbortSignal,
  ) {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let total: number | undefined = descriptor.byteLength;
    do {
      const end = offset + RESOURCE_RANGE_BYTES - 1;
      const response = await this.fetchImpl(
        `${this.base}/resources/${encodeURIComponent(generation)}/${encodeURIComponent(descriptor.id)}`,
        {
          credentials: "same-origin",
          headers: { range: `bytes=${offset}-${end}` },
          signal,
        },
      );
      if (!response.ok) {
        throw new BrowserReviewApiError(
          response.status === 409
            ? "The review changed while this file was loading."
            : "Review resource could not be loaded.",
          response.status,
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      chunks.push(bytes);
      const contentRange = response.headers.get("content-range")?.match(/\/([0-9]+)$/);
      if (contentRange) total = Number(contentRange[1]);
      else if (response.status === 200) total = bytes.byteLength;
      else if (total === undefined)
        throw new Error("Review resource response omitted its total size.");
      offset += bytes.byteLength;
      if (bytes.byteLength === 0 && offset < total) throw new Error("Review resource ended early.");
    } while (total === undefined || offset < total);

    const bytes = new Uint8Array(offset);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    if (descriptor.byteLength !== undefined && bytes.byteLength !== descriptor.byteLength) {
      throw new Error("Review resource size did not match its descriptor.");
    }
    if (descriptor.digest && (await sha256(bytes)) !== descriptor.digest.toLowerCase()) {
      throw new Error("Review resource digest did not match its descriptor.");
    }
    return new TextDecoder().decode(bytes);
  }

  private async probeStatus() {
    const response = await this.fetchImpl(`${this.base}/snapshot`, {
      credentials: "same-origin",
    });
    return response.ok ? undefined : response.status;
  }

  private async json<T>(url: string): Promise<T> {
    const response = await this.fetchImpl(url, { credentials: "same-origin" });
    if (!response.ok) {
      throw new BrowserReviewApiError(
        response.status === 401
          ? "Review authorization expired. Reopen the local review link."
          : "The local review session is no longer available.",
        response.status,
      );
    }
    return response.json() as Promise<T>;
  }
}
