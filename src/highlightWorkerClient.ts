/**
 * Brokers terminal syntax-highlighting jobs through Bun's compiled-entrypoint worker support.
 *
 * The executable registers the interactive worker because Bun resolves compiled worker URLs from
 * the entrypoint module; UI callers consume this narrow request queue through its local re-export.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import type { CompactHighlightedDiff } from "./ui/diff/highlightCompact";

export type WorkerHighlightedDiffCode = CompactHighlightedDiff;

interface HighlightWorkerRequest {
  version: 2;
  id: number;
  metadata: FileDiffMetadata;
  appearance: "dark" | "light";
  language: string;
  theme: string;
}

type HighlightWorkerResponse =
  | { version: 2; id: number; ok: true; code: WorkerHighlightedDiffCode }
  | { version: 2; id: number; ok: false; message: string };

interface PendingHighlightRequest {
  id: number;
  metadata: FileDiffMetadata;
  appearance: "dark" | "light";
  language: string;
  theme: string;
  resolve: (code: WorkerHighlightedDiffCode) => void;
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

/** Register the compiled-entrypoint worker that the interactive app started. */
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

  // Unit tests run this module without the interactive entrypoint. Production registers the
  // worker from src/main.tsx, where Bun can resolve the additional compiled entrypoint.
  return useHighlightWorker(new Worker(new URL("./highlightWorker.js", import.meta.url).href));
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

/** Receive replies from the one worker and ignore no-longer-relevant messages. */
function handleWorkerMessage(event: MessageEvent<HighlightWorkerResponse>) {
  const response = event.data;
  const request = activeRequest;
  if (!request || response.version !== 2 || response.id !== request.id) {
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
    const message: HighlightWorkerRequest = {
      version: 2,
      id: request.id,
      metadata: request.metadata,
      appearance: request.appearance,
      language: request.language,
      theme: request.theme,
    };
    getHighlightWorker().postMessage(message);
  } catch (error) {
    resetWorker(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Highlight one diff in the Bun worker after earlier requests finish. */
export function highlightDiffInWorker({
  appearance,
  language,
  metadata,
  theme,
}: {
  appearance: "dark" | "light";
  language: string;
  metadata: FileDiffMetadata;
  theme: string;
}) {
  return new Promise<WorkerHighlightedDiffCode>((resolve, reject) => {
    queuedRequests.push({
      id: nextRequestId++,
      appearance,
      language,
      metadata,
      theme,
      resolve,
      reject,
    });
    runNextRequest();
  });
}

/** Terminate the shared worker when a controlled caller needs to release it. */
export function disposeHighlightWorker() {
  resetWorker(new Error("The syntax highlighting worker was disposed."));
}
