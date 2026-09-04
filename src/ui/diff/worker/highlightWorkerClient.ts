/**
 * Brokers terminal syntax-highlighting jobs through Bun's compiled-entrypoint worker support.
 *
 * Grammar generations configure each worker before its first matching job. A changed generation
 * replaces the worker, so stale grammar code and responses cannot cross an extension reload.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  subscribeSyntaxGrammarChanges,
  syntaxGrammarSnapshot,
} from "../../../core/changeset/syntaxGrammar";
import type { ExtensionSyntaxGrammar } from "../../../extension-api/types";
import { createHighlightWorker } from "../../../highlightWorkerClient";
import type { CompactHighlightedDiff } from "./highlightCompact";

export type WorkerHighlightedDiffCode = CompactHighlightedDiff;
export const HIGHLIGHT_WORKER_TIMEOUT_MS = 15_000;

type HighlightWorkerRequest =
  | {
      version: 4;
      type: "configure";
      generation: number;
      digest: string;
      grammars: readonly ExtensionSyntaxGrammar[];
    }
  | {
      version: 4;
      type: "highlight";
      id: number;
      grammarGeneration: number;
      aliasContext: boolean;
      metadata: FileDiffMetadata;
      appearance: "dark" | "light";
      language: string;
      theme: string;
    };

type HighlightWorkerResponse =
  | { version: 4; type: "configured"; generation: number; ok: true }
  | { version: 4; type: "configured"; generation: number; ok: false; message: string }
  | { version: 4; type: "highlight"; id: number; ok: true; code: WorkerHighlightedDiffCode }
  | { version: 4; type: "highlight"; id: number; ok: false; message: string };

interface PendingHighlightRequest {
  id: number;
  grammarGeneration: number;
  aliasContext: boolean;
  metadata: FileDiffMetadata;
  appearance: "dark" | "light";
  language: string;
  theme: string;
  resolve: (code: WorkerHighlightedDiffCode) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;
let activeRequest: PendingHighlightRequest | null = null;
let configuredGeneration = -1;
let configurationInFlight: number | null = null;
let requestTimer: ReturnType<typeof setTimeout> | undefined;
let requestTimeoutMs = HIGHLIGHT_WORKER_TIMEOUT_MS;
let nextRequestId = 1;
const queuedRequests: PendingHighlightRequest[] = [];

/** Clear the kill timer shared by configuration and highlighting. */
function clearRequestTimer() {
  if (requestTimer) clearTimeout(requestTimer);
  requestTimer = undefined;
}

/** Kill a worker whose grammar or highlight regexes stop making progress. */
function armRequestTimer(label: string) {
  clearRequestTimer();
  requestTimer = setTimeout(() => {
    resetWorker(new Error(`${label} timed out after ${requestTimeoutMs}ms.`));
  }, requestTimeoutMs);
  requestTimer.unref?.();
}

/** Attach the one message/error protocol every worker instance uses. */
function useHighlightWorker(nextWorker: Worker) {
  (nextWorker as Worker & { unref?: () => void }).unref?.();
  nextWorker.onmessage = handleWorkerMessage;
  nextWorker.onerror = handleWorkerError;
  worker = nextWorker;
  configuredGeneration = -1;
  configurationInFlight = null;
  return nextWorker;
}

/** Register a caller-provided worker, with an optional short timeout for deterministic tests. */
export function registerHighlightWorker(nextWorker: Worker, options: { timeoutMs?: number } = {}) {
  if (worker && worker !== nextWorker)
    resetWorker(new Error("The syntax highlighting worker was replaced."));
  requestTimeoutMs = options.timeoutMs ?? HIGHLIGHT_WORKER_TIMEOUT_MS;
  return useHighlightWorker(nextWorker);
}

/** Return one reusable worker without keeping short-lived Bun processes alive. */
function getHighlightWorker() {
  return worker ?? useHighlightWorker(createHighlightWorker());
}

/** Resolve or reject the active job and advance the serialized queue. */
function settleActiveRequest(settle: (request: PendingHighlightRequest) => void) {
  clearRequestTimer();
  const request = activeRequest;
  activeRequest = null;
  if (request) settle(request);
  runNextRequest();
}

/** Receive configuration acknowledgements and highlight results. */
function handleWorkerMessage(event: MessageEvent<HighlightWorkerResponse>) {
  const response = event.data;
  if (response.version !== 4) return;
  if (response.type === "configured") {
    if (response.generation !== configurationInFlight) return;
    clearRequestTimer();
    configurationInFlight = null;
    if (!response.ok) {
      resetWorker(new Error(response.message));
      return;
    }
    configuredGeneration = response.generation;
    runNextRequest();
    return;
  }

  const request = activeRequest;
  if (!request || response.id !== request.id) return;
  if (response.ok) settleActiveRequest((active) => active.resolve(response.code));
  else settleActiveRequest((active) => active.reject(new Error(response.message)));
}

/** Drop a broken worker and fail every request rather than leaving stale work behind. */
function resetWorker(error: Error) {
  clearRequestTimer();
  const currentWorker = worker;
  worker = null;
  configuredGeneration = -1;
  configurationInFlight = null;
  if (currentWorker) void currentWorker.terminate();
  const pending = [activeRequest, ...queuedRequests].filter(
    (request): request is PendingHighlightRequest => request !== null,
  );
  activeRequest = null;
  queuedRequests.length = 0;
  for (const request of pending) request.reject(error);
}

/** Fail pending work when Bun reports a worker startup or runtime error. */
function handleWorkerError(event: ErrorEvent) {
  resetWorker(new Error(event.message || "The syntax highlighting worker failed."));
}

/** Configure the worker before posting a job for the active grammar generation. */
function configureWorker() {
  const snapshot = syntaxGrammarSnapshot();
  if (configuredGeneration === snapshot.generation || configurationInFlight !== null) return;
  const currentWorker = getHighlightWorker();
  configurationInFlight = snapshot.generation;
  const message: HighlightWorkerRequest = {
    version: 4,
    type: "configure",
    generation: snapshot.generation,
    digest: snapshot.digest,
    grammars: snapshot.grammars,
  };
  currentWorker.postMessage(message);
  armRequestTimer("Syntax grammar configuration");
}

/** Post the next job only after the worker has matching grammar data. */
function runNextRequest() {
  if (activeRequest || queuedRequests.length === 0) return;
  const request = queuedRequests[0]!;
  if (configuredGeneration !== request.grammarGeneration) {
    try {
      configureWorker();
    } catch (error) {
      resetWorker(error instanceof Error ? error : new Error(String(error)));
    }
    return;
  }
  queuedRequests.shift();
  activeRequest = request;
  try {
    const message: HighlightWorkerRequest = {
      version: 4,
      type: "highlight",
      id: request.id,
      grammarGeneration: request.grammarGeneration,
      aliasContext: request.aliasContext,
      metadata: request.metadata,
      appearance: request.appearance,
      language: request.language,
      theme: request.theme,
    };
    getHighlightWorker().postMessage(message);
    armRequestTimer("Syntax highlighting");
  } catch (error) {
    resetWorker(error instanceof Error ? error : new Error(String(error)));
  }
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
  const generation = syntaxGrammarSnapshot().generation;
  const pendingGeneration =
    activeRequest?.grammarGeneration ?? queuedRequests[0]?.grammarGeneration;
  if (
    worker &&
    (pendingGeneration !== undefined
      ? pendingGeneration !== generation
      : configurationInFlight !== null && configurationInFlight !== generation)
  ) {
    resetWorker(new Error("Syntax grammar configuration changed."));
  }
  return new Promise<WorkerHighlightedDiffCode>((resolve, reject) => {
    queuedRequests.push({
      id: nextRequestId++,
      grammarGeneration: generation,
      aliasContext,
      appearance,
      language,
      metadata,
      theme,
      resolve,
      reject,
    });
    try {
      runNextRequest();
    } catch (error) {
      resetWorker(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

subscribeSyntaxGrammarChanges(() => {
  if (worker || activeRequest || queuedRequests.length > 0) {
    resetWorker(new Error("Syntax grammar configuration changed."));
  }
});

/** Terminate the shared worker when a controlled caller needs to release it. */
export function disposeHighlightWorker() {
  resetWorker(new Error("The syntax highlighting worker was disposed."));
  requestTimeoutMs = HIGHLIGHT_WORKER_TIMEOUT_MS;
}
