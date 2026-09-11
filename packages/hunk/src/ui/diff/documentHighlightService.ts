import { createHash } from "node:crypto";
import type { AppTheme } from "../themes";
import {
  DocumentHighlighterConfigurationError,
  renderHighlightedDocumentLines,
} from "./documentHighlightRenderer";
import { DOCUMENT_HIGHLIGHT_RENDER_OPTIONS_REVISION } from "./highlightRenderOptions";
import { syntaxHighlightThemeName } from "./syntaxHighlightTheme";
import {
  compactHighlightedDocumentByteLength,
  compactHighlightedDocumentRunsForLine,
  documentWorkerEligibility,
  encodeCompactHighlightedDocument,
  highlightDocumentInWorker,
  HighlightWorkerClientError,
  type CompactHighlightedDocument,
  type DocumentWorkerEligibility,
} from "./worker";

const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_CACHE_ENTRIES = 128;
// Each unique entry can retain a 1 MiB input while worker and inline execution are serialized.
const DEFAULT_MAX_IN_FLIGHT_ENTRIES = 16;
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
  | "busy"
  | "invalid-document"
  | "unsupported-language"
  | "highlight-failed"
  | "worker-failed";

/** One paint-only syntax range projected from a highlighted document line. */
export interface DocumentHighlightRun {
  start: number;
  end: number;
  fg?: string;
}

interface HighlightedDocumentResult {
  readonly status: "highlighted";
  readonly retryable: false;
}

const compactDocuments = new WeakMap<HighlightedDocumentResult, CompactHighlightedDocument>();

/** Stable document-oriented result returned by highlighting or its readable fallback. */
export type DocumentHighlightResult =
  | HighlightedDocumentResult
  | {
      readonly status: "fallback";
      readonly reason: DocumentHighlightFallbackReason;
      readonly retryable: boolean;
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
  maxInFlightEntries?: number;
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

/** Wrap one compact artifact behind the document-oriented service boundary. */
function highlightedResult(compact: CompactHighlightedDocument): HighlightedDocumentResult {
  const result: HighlightedDocumentResult = {
    status: "highlighted",
    retryable: false,
  };
  compactDocuments.set(result, compact);
  return Object.freeze(result);
}

/** Read the compact artifact behind one service-owned highlighted result. */
function compactDocument(result: HighlightedDocumentResult) {
  const compact = compactDocuments.get(result);
  if (!compact) throw new Error("Highlighted document result lost its compact artifact.");
  return compact;
}

/** Project one line's syntax ranges without exposing worker payload types to consumers. */
export function documentHighlightRunsForLine(
  result: DocumentHighlightResult | null | undefined,
  lineIndex: number,
): DocumentHighlightRun[] {
  if (!result || result.status !== "highlighted") return [];
  const compact = compactDocument(result);
  if (
    !Number.isInteger(lineIndex) ||
    lineIndex < 0 ||
    lineIndex >= compact.document.lineOffsets.length - 1
  ) {
    return [];
  }
  return compactHighlightedDocumentRunsForLine(compact, lineIndex);
}

/** Normalize authored newlines before identity, validation, or rendering observes the document. */
function normalizeDocumentText(text: string) {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** Snapshot caller-owned inputs before identity or asynchronous scheduling can observe mutation. */
function snapshotInput(input: DocumentHighlightInput): Omit<DocumentHighlightInput, "signal"> {
  const syntaxScopeOverrides = input.theme.syntaxScopeOverrides
    ? Object.freeze({ ...input.theme.syntaxScopeOverrides })
    : undefined;
  const theme = Object.freeze({
    ...input.theme,
    syntaxColors: Object.freeze({ ...input.theme.syntaxColors }),
    ...(syntaxScopeOverrides === undefined ? {} : { syntaxScopeOverrides }),
  });
  return Object.freeze({
    text: normalizeDocumentText(input.text),
    path: input.path,
    language: input.language,
    theme,
    offloadLargeDiff: input.offloadLargeDiff === true,
  });
}

/** Hash normalized render-affecting inputs with explicit field boundaries. */
function normalizedDocumentHighlightCacheKey({
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

/** Hash every render-affecting input after applying the service's newline normalization. */
export function documentHighlightCacheKey(
  input: Omit<DocumentHighlightInput, "offloadLargeDiff" | "signal">,
) {
  return normalizedDocumentHighlightCacheKey({
    ...input,
    text: normalizeDocumentText(input.text),
  });
}

/** Return the cache charge for one immutable completed result. */
function resultCost(result: DocumentHighlightResult) {
  return (
    CACHE_ENTRY_OVERHEAD_BYTES +
    (result.status === "highlighted"
      ? compactHighlightedDocumentByteLength(compactDocument(result))
      : 0)
  );
}

/** Build one immutable fallback result that is safe to share through cache hits. */
function fallbackResult(
  reason: DocumentHighlightFallbackReason,
  retryable: boolean,
): DocumentHighlightResult {
  return Object.freeze({ status: "fallback", reason, retryable });
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
    return fallbackResult(reason, error.retryable);
  }
  return fallbackResult("worker-failed", true);
}

/** Build one isolated service; production uses the shared instance below. */
export function createDocumentHighlightService(options: DocumentHighlightServiceOptions = {}) {
  const maxCacheBytes = Math.max(1, Math.floor(options.maxCacheBytes ?? DEFAULT_CACHE_BYTES));
  const maxCacheEntries = Math.max(1, Math.floor(options.maxCacheEntries ?? DEFAULT_CACHE_ENTRIES));
  const maxInFlightEntries = Math.max(
    1,
    Math.floor(options.maxInFlightEntries ?? DEFAULT_MAX_IN_FLIGHT_ENTRIES),
  );
  const completed = new Map<string, CompletedCacheEntry>();
  const inFlight = new Map<string, InFlightEntry>();
  let completedCost = 0;
  // Aborted entries remain charged until their queued or active underlying work settles.
  let outstandingEntries = 0;

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
        signal,
        text,
        theme,
      });
      if (signal.aborted) throw new DocumentHighlightAbortedError();
      return encodeCompactHighlightedDocument(lines, theme.appearance);
    });

  /** Read and refresh one immutable cache entry without exposing its retained buffers. */
  const cachedResult = (key: string) => {
    const entry = completed.get(key);
    if (!entry) return undefined;
    completed.delete(key);
    completed.set(key, entry);
    return entry.result;
  };

  /** Store one immutable result while enforcing both byte and entry ceilings. */
  const cacheResult = (key: string, result: DocumentHighlightResult) => {
    const cost = resultCost(result);
    if (cost > maxCacheBytes) return;

    const previous = completed.get(key);
    if (previous) completedCost -= previous.cost;
    completed.delete(key);
    completed.set(key, { cost, result });
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
      return fallbackResult("invalid-document", false);
    }

    if (input.offloadLargeDiff && workerDecision.eligible) {
      try {
        const compact = await workerHighlight({
          ...workerDecision.input,
          signal,
        });
        return highlightedResult(compact);
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
      return highlightedResult(compact);
    } catch (error) {
      if (signal.aborted || error instanceof DocumentHighlightAbortedError) {
        throw new DocumentHighlightAbortedError();
      }
      return error instanceof DocumentHighlighterConfigurationError
        ? fallbackResult("unsupported-language", false)
        : fallbackResult("highlight-failed", true);
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
        (result) => finish(() => resolve(result)),
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

      const snapshot = snapshotInput(input);
      const key = normalizedDocumentHighlightCacheKey(snapshot);
      const cached = cachedResult(key);
      if (cached) return Promise.resolve(cached);

      let entry = inFlight.get(key);
      if (!entry) {
        if (outstandingEntries >= maxInFlightEntries) {
          return Promise.resolve(fallbackResult("busy", true));
        }
        const controller = new AbortController();
        entry = {
          controller,
          subscribers: 0,
          promise: Promise.resolve(undefined as never),
        };
        const capturedEntry = entry;
        outstandingEntries += 1;
        entry.promise = Promise.resolve()
          .then(() => execute(snapshot, key, controller.signal))
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
            outstandingEntries -= 1;
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
        outstandingEntries,
      };
    },
  };
}

const SHARED_DOCUMENT_HIGHLIGHT_SERVICE = createDocumentHighlightService();

/** Highlight one document through the process-wide bounded service. */
export function loadDocumentHighlight(input: DocumentHighlightInput) {
  return SHARED_DOCUMENT_HIGHLIGHT_SERVICE.highlight(input);
}
