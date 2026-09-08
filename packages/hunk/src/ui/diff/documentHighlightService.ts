import { createHash } from "node:crypto";
import type { AppTheme } from "../themes";
import { renderHighlightedDocumentLines } from "./documentHighlightRenderer";
import { DOCUMENT_HIGHLIGHT_RENDER_OPTIONS_REVISION } from "./highlightRenderOptions";
import { syntaxHighlightThemeName } from "./syntaxHighlightTheme";
import {
  cloneCompactHighlightedDocument,
  compactHighlightedDocumentByteLength,
  documentWorkerEligibility,
  encodeCompactHighlightedDocument,
  highlightDocumentInWorker,
  HighlightWorkerClientError,
  type CompactHighlightedDocument,
  type DocumentWorkerEligibility,
} from "./worker";

const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CACHE_ENTRIES = 128;
const CACHE_ENTRY_OVERHEAD_BYTES = 256;

/** Inputs that fully determine one complete-document syntax result. */
export interface DocumentHighlightInput {
  text: string;
  path: string;
  language: string;
  theme: AppTheme;
  offloadLargeDiff: boolean;
  signal?: AbortSignal;
}

export type DocumentHighlightFallbackReason =
  | "invalid-document"
  | "unsupported-language"
  | "highlight-failed"
  | "worker-failed";

/** Stable paint input returned by document highlighting or its readable fallback. */
export type DocumentHighlightResult =
  | {
      status: "highlighted";
      compact: CompactHighlightedDocument;
      retryable: false;
    }
  | {
      status: "fallback";
      reason: DocumentHighlightFallbackReason;
      retryable: boolean;
    };

/** Marks a subscriber that stopped waiting without changing other shared subscribers. */
export class DocumentHighlightAbortedError extends Error {
  constructor() {
    super("The document highlighting request was aborted.");
    this.name = "DocumentHighlightAbortedError";
  }
}

interface CompletedCacheEntry {
  cost: number;
  result: DocumentHighlightResult;
}

interface InFlightEntry {
  controller: AbortController;
  promise: Promise<DocumentHighlightResult>;
  subscribers: number;
}

interface DocumentHighlightServiceOptions {
  maxCacheBytes?: number;
  maxCacheEntries?: number;
  workerEligibility?: (input: {
    language: string;
    path: string;
    text: string;
    theme: AppTheme;
  }) => DocumentWorkerEligibility;
  workerHighlight?: typeof highlightDocumentInWorker;
  inlineHighlight?: (input: {
    cacheKey: string;
    language: string;
    path: string;
    text: string;
    theme: AppTheme;
    signal: AbortSignal;
  }) => Promise<CompactHighlightedDocument>;
}

/** Clone one result so callers cannot mutate cache-owned typed-array buffers. */
function cloneResult(result: DocumentHighlightResult): DocumentHighlightResult {
  return result.status === "highlighted"
    ? {
        status: "highlighted",
        compact: cloneCompactHighlightedDocument(result.compact),
        retryable: false,
      }
    : { ...result };
}

/** Hash every render-affecting input with explicit field boundaries. */
export function documentHighlightCacheKey({
  language,
  path,
  text,
  theme,
}: Omit<DocumentHighlightInput, "offloadLargeDiff" | "signal">) {
  const fields = [
    String(DOCUMENT_HIGHLIGHT_RENDER_OPTIONS_REVISION),
    theme.appearance,
    path,
    language,
    syntaxHighlightThemeName(theme),
    theme.syntaxTheme ?? "",
    JSON.stringify(Object.entries(theme.syntaxScopeOverrides ?? {})),
    text,
  ];
  const hash = createHash("sha256");
  for (const field of fields) hash.update(`${field.length}:`).update(field);
  return hash.digest("hex");
}

/** Return the cache charge for one immutable completed result. */
function resultCost(result: DocumentHighlightResult) {
  return (
    CACHE_ENTRY_OVERHEAD_BYTES +
    (result.status === "highlighted" ? compactHighlightedDocumentByteLength(result.compact) : 0)
  );
}

/** Classify a worker failure without relying on human-readable messages. */
function workerFallback(error: unknown): DocumentHighlightResult {
  if (error instanceof HighlightWorkerClientError) {
    const reason: DocumentHighlightFallbackReason =
      error.code === "unsupported-language"
        ? "unsupported-language"
        : error.code === "invalid-request"
          ? "invalid-document"
          : error.retryable
            ? "worker-failed"
            : "highlight-failed";
    return { status: "fallback", reason, retryable: error.retryable };
  }
  return { status: "fallback", reason: "worker-failed", retryable: true };
}

/** Build one isolated service; production uses the shared instance below. */
export function createDocumentHighlightService(options: DocumentHighlightServiceOptions = {}) {
  const maxCacheBytes = Math.max(1, Math.floor(options.maxCacheBytes ?? DEFAULT_CACHE_BYTES));
  const maxCacheEntries = Math.max(1, Math.floor(options.maxCacheEntries ?? DEFAULT_CACHE_ENTRIES));
  const completed = new Map<string, CompletedCacheEntry>();
  const inFlight = new Map<string, InFlightEntry>();
  let completedCost = 0;

  const eligibility = options.workerEligibility ?? documentWorkerEligibility;
  const workerHighlight = options.workerHighlight ?? highlightDocumentInWorker;
  const inlineHighlight =
    options.inlineHighlight ??
    (async ({ cacheKey, language, path, signal, text, theme }) => {
      if (signal.aborted) throw new DocumentHighlightAbortedError();
      const lines = await renderHighlightedDocumentLines({
        cacheKey,
        language,
        path,
        text,
        theme,
      });
      if (signal.aborted) throw new DocumentHighlightAbortedError();
      return encodeCompactHighlightedDocument(lines, theme.appearance);
    });

  /** Read and refresh one cache entry without exposing its retained buffers. */
  const cachedResult = (key: string) => {
    const entry = completed.get(key);
    if (!entry) return undefined;
    completed.delete(key);
    completed.set(key, entry);
    return cloneResult(entry.result);
  };

  /** Store one owned clone while enforcing both byte and entry ceilings. */
  const cacheResult = (key: string, result: DocumentHighlightResult) => {
    const owned = cloneResult(result);
    const cost = resultCost(owned);
    if (cost > maxCacheBytes) return;

    const previous = completed.get(key);
    if (previous) completedCost -= previous.cost;
    completed.delete(key);
    completed.set(key, { cost, result: owned });
    completedCost += cost;

    while (completedCost > maxCacheBytes || completed.size > maxCacheEntries) {
      const oldest = completed.entries().next().value;
      if (!oldest) break;
      completed.delete(oldest[0]);
      completedCost -= oldest[1].cost;
    }
  };

  /** Run one underlying request, using the worker only under the shared eligibility policy. */
  const execute = async (
    input: Omit<DocumentHighlightInput, "signal">,
    key: string,
    signal: AbortSignal,
  ): Promise<DocumentHighlightResult> => {
    const workerDecision = eligibility(input);
    if (!workerDecision.eligible && workerDecision.reason === "invalid-document") {
      return {
        status: "fallback",
        reason: "invalid-document",
        retryable: false,
      };
    }

    if (input.offloadLargeDiff && workerDecision.eligible) {
      try {
        const compact = await workerHighlight({
          ...workerDecision.input,
          signal,
        });
        return { status: "highlighted", compact, retryable: false };
      } catch (error) {
        if (signal.aborted) throw new DocumentHighlightAbortedError();
        return workerFallback(error);
      }
    }

    try {
      const compact = await inlineHighlight({
        ...input,
        cacheKey: key,
        signal,
      });
      return { status: "highlighted", compact, retryable: false };
    } catch (error) {
      if (signal.aborted || error instanceof DocumentHighlightAbortedError) {
        throw new DocumentHighlightAbortedError();
      }
      return {
        status: "fallback",
        reason: "unsupported-language",
        retryable: false,
      };
    }
  };

  /** Subscribe one caller to a shared request while keeping cancellation subscriber-local. */
  const subscribe = (
    entry: InFlightEntry,
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<DocumentHighlightResult> => {
    entry.subscribers += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        entry.subscribers -= 1;
        run();
      };
      const abort = () => {
        finish(() => reject(new DocumentHighlightAbortedError()));
        if (entry.subscribers === 0 && inFlight.get(key) === entry) {
          inFlight.delete(key);
          entry.controller.abort();
        }
      };

      signal?.addEventListener("abort", abort, { once: true });
      entry.promise.then(
        (result) => finish(() => resolve(cloneResult(result))),
        (error) => finish(() => reject(error)),
      );
    });
  };

  return {
    /** Highlight or fall back for one document without exposing shared mutable artifacts. */
    highlight(input: DocumentHighlightInput) {
      if (input.signal?.aborted) {
        return Promise.reject(new DocumentHighlightAbortedError());
      }

      const key = documentHighlightCacheKey(input);
      const cached = cachedResult(key);
      if (cached) return Promise.resolve(cached);

      let entry = inFlight.get(key);
      if (!entry) {
        const controller = new AbortController();
        entry = {
          controller,
          subscribers: 0,
          promise: Promise.resolve(undefined as never),
        };
        const capturedEntry = entry;
        entry.promise = Promise.resolve()
          .then(() => execute(input, key, controller.signal))
          .then((result) => {
            if (
              inFlight.get(key) === capturedEntry &&
              !controller.signal.aborted &&
              !result.retryable
            ) {
              cacheResult(key, result);
            }
            return result;
          })
          .finally(() => {
            if (inFlight.get(key) === capturedEntry) inFlight.delete(key);
          });
        inFlight.set(key, entry);
      }

      return subscribe(entry, key, input.signal);
    },

    /** Clear completed results; exposed for isolated lifecycle tests and controlled teardown. */
    clear() {
      completed.clear();
      completedCost = 0;
    },

    /** Report bounded bookkeeping without exposing cache contents. */
    stats() {
      return {
        completedEntries: completed.size,
        completedBytes: completedCost,
        inFlight: inFlight.size,
      };
    },
  };
}

const SHARED_DOCUMENT_HIGHLIGHT_SERVICE = createDocumentHighlightService();

/** Highlight one document through the process-wide bounded service. */
export function loadDocumentHighlight(input: DocumentHighlightInput) {
  return SHARED_DOCUMENT_HIGHLIGHT_SERVICE.highlight(input);
}
