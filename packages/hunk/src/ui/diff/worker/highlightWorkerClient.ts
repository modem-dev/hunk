/**
 * Brokers terminal syntax-highlighting jobs through Bun's compiled-entrypoint worker support.
 *
 * Diff and complete-document requests share one serialized queue. The client validates every
 * matching response before handing compact token ranges to UI callers.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import { createHighlightWorker } from "../../../highlightWorkerClient";
import {
  validateCompactHighlightedDiff,
  validateCompactHighlightedDocument,
  type CompactHighlightedDiff,
  type CompactHighlightedDocument,
} from "./highlightCompact";
import {
  describeHighlightWorkerDocumentIssue,
  highlightWorkerDocumentLineLengths,
  HIGHLIGHT_WORKER_PROTOCOL_VERSION,
  isHighlightWorkerFailureCode,
  isHighlightWorkerFailureRetryable,
  type HighlightWorkerDiffRequest,
  type HighlightWorkerDocumentRequest,
  type HighlightWorkerFailureCode,
  type HighlightWorkerRequest,
  type HighlightWorkerResponse,
} from "./highlightWorkerProtocol";

export type WorkerHighlightedDiffCode = CompactHighlightedDiff;
export type WorkerHighlightedDocumentCode = CompactHighlightedDocument;

type WorkerHighlightedCode = WorkerHighlightedDiffCode | WorkerHighlightedDocumentCode;

/** Classifies worker-client failures for retry and fallback policy. */
export type HighlightWorkerClientErrorCode =
  | HighlightWorkerFailureCode
  | "aborted"
  | "protocol-error"
  | "worker-failed"
  | "worker-replaced"
  | "worker-disposed";

/** Carries a stable failure code and retry policy across the private worker boundary. */
export class HighlightWorkerClientError extends Error {
  constructor(
    readonly code: HighlightWorkerClientErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "HighlightWorkerClientError";
  }
}

interface PendingHighlightRequest {
  request: HighlightWorkerRequest;
  resolve: (code: WorkerHighlightedCode) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
  aborted: boolean;
}

let worker: Worker | null = null;
let activeRequest: PendingHighlightRequest | null = null;
let nextRequestId = 1;
const queuedRequests: PendingHighlightRequest[] = [];

/** Build one stable client error without relying on message inspection. */
function clientError(code: HighlightWorkerClientErrorCode, retryable: boolean, message: string) {
  return new HighlightWorkerClientError(code, retryable, message);
}

/** Detach request-scoped cancellation as soon as one request settles. */
function detachAbortListener(request: PendingHighlightRequest) {
  if (request.signal && request.abortHandler) {
    request.signal.removeEventListener("abort", request.abortHandler);
  }
  request.abortHandler = undefined;
  request.signal = undefined;
}

/** Attach the one message/error protocol every worker instance uses. */
function useHighlightWorker(nextWorker: Worker) {
  // Bun workers otherwise keep a static command or test process alive after its last request.
  (nextWorker as Worker & { unref?: () => void }).unref?.();
  nextWorker.onmessage = (event) => handleWorkerMessage(nextWorker, event);
  nextWorker.onerror = (event) => handleWorkerError(nextWorker, event);
  worker = nextWorker;
  return nextWorker;
}

/** Register a caller-provided worker, such as a deterministic test double. */
export function registerHighlightWorker(nextWorker: Worker) {
  if (worker && worker !== nextWorker) {
    resetWorker(
      clientError("worker-replaced", true, "The syntax highlighting worker was replaced."),
    );
  }
  return useHighlightWorker(nextWorker);
}

/** Return one reusable worker without keeping short-lived Bun processes alive. */
function getHighlightWorker() {
  if (worker) {
    return worker;
  }

  // Construction runs inside `runNextRequest`'s try/catch, so unavailable workers leave the
  // visible diff plain rather than aborting the interactive application.
  return useHighlightWorker(createHighlightWorker());
}

/** Resolve or reject the active job and advance the serialized message queue. */
function settleActiveRequest(settle: (request: PendingHighlightRequest) => void) {
  const request = activeRequest;
  activeRequest = null;
  if (request) {
    detachAbortListener(request);
    if (!request.aborted) settle(request);
  }
  runNextRequest();
}

/** Return whether an unknown value has a numeric worker request ID. */
function responseId(value: unknown) {
  if (!value || typeof value !== "object" || !("id" in value)) return undefined;
  return typeof value.id === "number" ? value.id : undefined;
}

/** Validate one response against the active request and its compact payload kind. */
function validatedResponse(value: unknown, request: HighlightWorkerRequest) {
  if (!value || typeof value !== "object") {
    throw clientError(
      "protocol-error",
      true,
      "The syntax highlighting worker returned a malformed response.",
    );
  }

  const response = value as Record<string, unknown>;
  if (
    response.version !== HIGHLIGHT_WORKER_PROTOCOL_VERSION ||
    response.id !== request.id ||
    response.kind !== request.kind ||
    typeof response.ok !== "boolean"
  ) {
    throw clientError(
      "protocol-error",
      true,
      "The syntax highlighting worker returned a mismatched response.",
    );
  }

  if (!response.ok) {
    if (
      typeof response.message !== "string" ||
      !isHighlightWorkerFailureCode(response.code) ||
      typeof response.retryable !== "boolean" ||
      response.retryable !==
        (isHighlightWorkerFailureCode(response.code) &&
          isHighlightWorkerFailureRetryable(response.code))
    ) {
      throw clientError(
        "protocol-error",
        true,
        "The syntax highlighting worker returned a malformed failure.",
      );
    }
    return response as unknown as Extract<HighlightWorkerResponse, { ok: false }>;
  }

  if (!("code" in response)) {
    throw clientError(
      "protocol-error",
      true,
      "The syntax highlighting worker returned no compact payload.",
    );
  }
  if (response.kind === "diff") {
    validateCompactHighlightedDiff(response.code as CompactHighlightedDiff);
  } else {
    if (request.kind !== "document") {
      throw clientError(
        "protocol-error",
        true,
        "The syntax highlighting worker returned a mismatched response.",
      );
    }
    validateCompactHighlightedDocument(
      response.code as CompactHighlightedDocument,
      highlightWorkerDocumentLineLengths(request.text),
    );
  }
  return response as unknown as HighlightWorkerResponse;
}

/** Receive replies from the one worker and ignore replies for no-longer-relevant request IDs. */
function handleWorkerMessage(sourceWorker: Worker, event: MessageEvent<unknown>) {
  if (sourceWorker !== worker) return;
  const request = activeRequest;
  if (!request) {
    return;
  }

  const id = responseId(event.data);
  if (id !== undefined && id !== request.request.id) {
    return;
  }
  if (request.aborted && id === request.request.id) {
    settleActiveRequest(() => {});
    return;
  }

  let response: HighlightWorkerResponse;
  try {
    response = validatedResponse(event.data, request.request);
  } catch (error) {
    resetWorker(
      error instanceof HighlightWorkerClientError
        ? error
        : clientError(
            "protocol-error",
            true,
            error instanceof Error ? error.message : String(error),
          ),
    );
    return;
  }

  if (response.ok) {
    settleActiveRequest((active) => active.resolve(response.code));
    return;
  }

  settleActiveRequest((active) =>
    active.reject(clientError(response.code, response.retryable, response.message)),
  );
}

/** Drop a broken worker and fail every request rather than leaving stale work behind. */
function resetWorker(error: Error) {
  const currentWorker = worker;
  worker = null;
  if (currentWorker) {
    currentWorker.onmessage = null;
    currentWorker.onerror = null;
    void currentWorker.terminate();
  }

  const pending = [activeRequest, ...queuedRequests].filter(
    (request): request is PendingHighlightRequest => request !== null,
  );
  activeRequest = null;
  queuedRequests.length = 0;
  for (const request of pending) {
    detachAbortListener(request);
    if (!request.aborted) request.reject(error);
  }
}

/** Fail pending work when Bun reports a worker startup or runtime error. */
function handleWorkerError(sourceWorker: Worker, event: ErrorEvent) {
  if (sourceWorker !== worker) return;
  resetWorker(
    clientError("worker-failed", true, event.message || "The syntax highlighting worker failed."),
  );
}

/** Post the next job only after the previous reply has been processed. */
function runNextRequest() {
  if (activeRequest || queuedRequests.length === 0) {
    return;
  }

  const request = queuedRequests.shift();
  if (!request) {
    return;
  }

  activeRequest = request;
  try {
    getHighlightWorker().postMessage(request.request);
  } catch (error) {
    resetWorker(
      clientError("worker-failed", true, error instanceof Error ? error.message : String(error)),
    );
  }
}

/** Queue one typed job behind any active worker request with request-scoped cancellation. */
function enqueueHighlightRequest<T extends WorkerHighlightedCode>(
  request: HighlightWorkerRequest,
  signal?: AbortSignal,
) {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(clientError("aborted", false, "The syntax highlighting request was aborted."));
      return;
    }

    const pending: PendingHighlightRequest = {
      request,
      resolve: resolve as (code: WorkerHighlightedCode) => void,
      reject,
      signal,
      aborted: false,
    };
    if (signal) {
      pending.abortHandler = () => {
        if (pending.aborted) return;
        pending.aborted = true;
        detachAbortListener(pending);

        const queuedIndex = queuedRequests.indexOf(pending);
        if (queuedIndex >= 0) {
          queuedRequests.splice(queuedIndex, 1);
        }
        reject(clientError("aborted", false, "The syntax highlighting request was aborted."));
      };
      signal.addEventListener("abort", pending.abortHandler, { once: true });
    }

    queuedRequests.push(pending);
    runNextRequest();
  });
}

/** Highlight one diff in the Bun worker after earlier requests finish. */
export function highlightDiffInWorker({
  aliasContext,
  appearance,
  language,
  metadata,
  signal,
  theme,
}: {
  aliasContext: boolean;
  appearance: "dark" | "light";
  language: string;
  metadata: FileDiffMetadata;
  signal?: AbortSignal;
  theme: string;
}) {
  const request: HighlightWorkerDiffRequest = {
    version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
    id: nextRequestId++,
    kind: "diff",
    aliasContext,
    appearance,
    language,
    metadata,
    theme,
  };
  return enqueueHighlightRequest<WorkerHighlightedDiffCode>(request, signal);
}

/** Highlight one complete document in the Bun worker after earlier requests finish. */
export function highlightDocumentInWorker({
  appearance,
  language,
  path,
  signal,
  text,
  theme,
}: {
  appearance: "dark" | "light";
  language: string;
  path: string;
  signal?: AbortSignal;
  text: string;
  theme: string;
}) {
  const issue = describeHighlightWorkerDocumentIssue({
    language,
    path,
    text,
    theme,
  });
  if (issue) {
    return Promise.reject(clientError("invalid-request", false, issue));
  }

  const request: HighlightWorkerDocumentRequest = {
    version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
    id: nextRequestId++,
    kind: "document",
    appearance,
    language,
    path,
    text,
    theme,
  };
  return enqueueHighlightRequest<WorkerHighlightedDocumentCode>(request, signal);
}

/** Terminate the shared worker when a controlled caller needs to release it. */
export function disposeHighlightWorker() {
  resetWorker(
    clientError("worker-disposed", false, "The syntax highlighting worker was disposed."),
  );
}
