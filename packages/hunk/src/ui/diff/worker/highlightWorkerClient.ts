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
  HIGHLIGHT_WORKER_PROTOCOL_VERSION,
  type HighlightWorkerDiffRequest,
  type HighlightWorkerDocumentRequest,
  type HighlightWorkerRequest,
  type HighlightWorkerResponse,
} from "./highlightWorkerProtocol";

export type WorkerHighlightedDiffCode = CompactHighlightedDiff;
export type WorkerHighlightedDocumentCode = CompactHighlightedDocument;

type WorkerHighlightedCode = WorkerHighlightedDiffCode | WorkerHighlightedDocumentCode;

interface PendingHighlightRequest {
  request: HighlightWorkerRequest;
  resolve: (code: WorkerHighlightedCode) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let activeRequest: PendingHighlightRequest | null = null;
let nextRequestId = 1;
const queuedRequests: PendingHighlightRequest[] = [];

/** Attach the one message/error protocol every worker instance uses. */
function useHighlightWorker(nextWorker: Worker) {
  // Bun workers otherwise keep a static command or test process alive after its last request.
  (nextWorker as Worker & { unref?: () => void }).unref?.();
  nextWorker.onmessage = handleWorkerMessage;
  nextWorker.onerror = handleWorkerError;
  worker = nextWorker;
  return nextWorker;
}

/** Register a caller-provided worker, such as a deterministic test double. */
export function registerHighlightWorker(nextWorker: Worker) {
  if (worker && worker !== nextWorker) {
    resetWorker(new Error("The syntax highlighting worker was replaced."));
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
    settle(request);
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
    throw new Error("The syntax highlighting worker returned a malformed response.");
  }

  const response = value as Record<string, unknown>;
  if (
    response.version !== HIGHLIGHT_WORKER_PROTOCOL_VERSION ||
    response.id !== request.id ||
    response.kind !== request.kind ||
    typeof response.ok !== "boolean"
  ) {
    throw new Error("The syntax highlighting worker returned a mismatched response.");
  }

  if (!response.ok) {
    if (typeof response.message !== "string") {
      throw new Error("The syntax highlighting worker returned a malformed failure.");
    }
    return response as unknown as Extract<HighlightWorkerResponse, { ok: false }>;
  }

  if (!("code" in response)) {
    throw new Error("The syntax highlighting worker returned no compact payload.");
  }
  if (response.kind === "diff") {
    validateCompactHighlightedDiff(response.code as CompactHighlightedDiff);
  } else {
    validateCompactHighlightedDocument(response.code as CompactHighlightedDocument);
  }
  return response as unknown as HighlightWorkerResponse;
}

/** Receive replies from the one worker and ignore replies for no-longer-relevant request IDs. */
function handleWorkerMessage(event: MessageEvent<unknown>) {
  const request = activeRequest;
  if (!request) {
    return;
  }

  const id = responseId(event.data);
  if (id !== undefined && id !== request.request.id) {
    return;
  }

  let response: HighlightWorkerResponse;
  try {
    response = validatedResponse(event.data, request.request);
  } catch (error) {
    resetWorker(error instanceof Error ? error : new Error(String(error)));
    return;
  }

  if (response.ok) {
    settleActiveRequest((active) => active.resolve(response.code));
    return;
  }

  settleActiveRequest((active) => active.reject(new Error(response.message)));
}

/** Drop a broken worker and fail every request rather than leaving stale work behind. */
function resetWorker(error: Error) {
  const currentWorker = worker;
  worker = null;
  if (currentWorker) {
    void currentWorker.terminate();
  }

  const pending = [activeRequest, ...queuedRequests].filter(
    (request): request is PendingHighlightRequest => request !== null,
  );
  activeRequest = null;
  queuedRequests.length = 0;
  for (const request of pending) {
    request.reject(error);
  }
}

/** Fail pending work when Bun reports a worker startup or runtime error. */
function handleWorkerError(event: ErrorEvent) {
  resetWorker(new Error(event.message || "The syntax highlighting worker failed."));
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
    resetWorker(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Queue one typed job behind any active worker request. */
function enqueueHighlightRequest<T extends WorkerHighlightedCode>(request: HighlightWorkerRequest) {
  return new Promise<T>((resolve, reject) => {
    queuedRequests.push({
      request,
      resolve: resolve as (code: WorkerHighlightedCode) => void,
      reject,
    });
    runNextRequest();
  });
}

/** Highlight one diff in the Bun worker after earlier requests finish. */
export function highlightDiffInWorker({
  aliasContext,
  appearance,
  language,
  metadata,
  theme,
}: {
  aliasContext: boolean;
  appearance: "dark" | "light";
  language: string;
  metadata: FileDiffMetadata;
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
  return enqueueHighlightRequest<WorkerHighlightedDiffCode>(request);
}

/** Highlight one complete document in the Bun worker after earlier requests finish. */
export function highlightDocumentInWorker({
  appearance,
  language,
  path,
  text,
  theme,
}: {
  appearance: "dark" | "light";
  language: string;
  path: string;
  text: string;
  theme: string;
}) {
  const issue = describeHighlightWorkerDocumentIssue({ language, path, text, theme });
  if (issue) {
    return Promise.reject(new Error(issue));
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
  return enqueueHighlightRequest<WorkerHighlightedDocumentCode>(request);
}

/** Terminate the shared worker when a controlled caller needs to release it. */
export function disposeHighlightWorker() {
  resetWorker(new Error("The syntax highlighting worker was disposed."));
}
