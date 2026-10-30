import type { FileDiffMetadata } from "@pierre/diffs";
import { DOCUMENT_HIGHLIGHT_MAX_LINE_LENGTH } from "../highlightRenderOptions";
import type { CompactHighlightedDiff, CompactHighlightedDocument } from "./highlightCompact";

/** Identifies the private main-thread/worker message contract. */
export const HIGHLIGHT_WORKER_PROTOCOL_VERSION = 5;

/** Bounds one complete document before it enters the worker queue. */
export const MAX_WORKER_DOCUMENT_TEXT_LENGTH = 1_000_000;
export const MAX_WORKER_DOCUMENT_LINES = 10_000;
/** Pierre skips tokenization at this length, so document jobs fall back instead of losing state. */
export const WORKER_DOCUMENT_TOKENIZE_MAX_LINE_LENGTH = DOCUMENT_HIGHLIGHT_MAX_LINE_LENGTH;

interface HighlightWorkerRequestBase {
  version: typeof HIGHLIGHT_WORKER_PROTOCOL_VERSION;
  id: number;
}

interface HighlightWorkerRenderRequestBase extends HighlightWorkerRequestBase {
  appearance: "dark" | "light";
  language: string;
  theme: string;
}

/** Requests Pierre diff rendering with optional complete-source context aliases. */
export interface HighlightWorkerDiffRequest extends HighlightWorkerRenderRequestBase {
  kind: "diff";
  aliasContext: boolean;
  metadata: FileDiffMetadata;
}

/** Requests complete-document rendering so TextMate lexical state spans every line. */
export interface HighlightWorkerDocumentRequest extends HighlightWorkerRenderRequestBase {
  kind: "document";
  path: string;
  text: string;
}

/** Asks the worker to load one theme and grammar ahead of the first render request. */
export interface HighlightWorkerPreloadRequest extends HighlightWorkerRequestBase {
  kind: "preload";
  theme: string;
  language: string;
}

export type HighlightWorkerRenderRequest =
  | HighlightWorkerDiffRequest
  | HighlightWorkerDocumentRequest;

export type HighlightWorkerRequest = HighlightWorkerRenderRequest | HighlightWorkerPreloadRequest;

interface HighlightWorkerResponseBase {
  version: typeof HIGHLIGHT_WORKER_PROTOCOL_VERSION;
  id: number;
}

export interface HighlightWorkerDiffSuccess extends HighlightWorkerResponseBase {
  kind: "diff";
  ok: true;
  code: CompactHighlightedDiff;
}

export interface HighlightWorkerDocumentSuccess extends HighlightWorkerResponseBase {
  kind: "document";
  ok: true;
  code: CompactHighlightedDocument;
}

export interface HighlightWorkerPreloadSuccess extends HighlightWorkerResponseBase {
  kind: "preload";
  ok: true;
}

export type HighlightWorkerSuccess =
  | HighlightWorkerDiffSuccess
  | HighlightWorkerDocumentSuccess
  | HighlightWorkerPreloadSuccess;

/** Classifies worker-side failures without making callers parse human-readable messages. */
export type HighlightWorkerFailureCode =
  | "invalid-request"
  | "unsupported-language"
  | "unsupported-theme"
  | "highlight-failed";

const HIGHLIGHT_WORKER_FAILURE_CODES = new Set<HighlightWorkerFailureCode>([
  "invalid-request",
  "unsupported-language",
  "unsupported-theme",
  "highlight-failed",
]);

/** Return whether a structured-cloned value names one protocol failure class. */
export function isHighlightWorkerFailureCode(value: unknown): value is HighlightWorkerFailureCode {
  return (
    typeof value === "string" &&
    HIGHLIGHT_WORKER_FAILURE_CODES.has(value as HighlightWorkerFailureCode)
  );
}

/** Return the protocol retry policy for one worker-side failure class. */
export function isHighlightWorkerFailureRetryable(code: HighlightWorkerFailureCode) {
  return code === "highlight-failed";
}

export interface HighlightWorkerFailure extends HighlightWorkerResponseBase {
  kind: HighlightWorkerRequest["kind"];
  ok: false;
  code: HighlightWorkerFailureCode;
  retryable: boolean;
  message: string;
}

export type HighlightWorkerResponse = HighlightWorkerSuccess | HighlightWorkerFailure;

const HIGHLIGHT_WORKER_REQUEST_KINDS = new Set<HighlightWorkerRequest["kind"]>([
  "diff",
  "document",
  "preload",
]);

/** Return whether an unknown value names one protocol request kind. */
export function isHighlightWorkerRequestKind(
  value: unknown,
): value is HighlightWorkerRequest["kind"] {
  return typeof value === "string" && HIGHLIGHT_WORKER_REQUEST_KINDS.has(value as never);
}

/** Explain why one preload request cannot enter the worker, or return undefined. */
export function describeHighlightWorkerPreloadIssue({
  language,
  theme,
}: Pick<HighlightWorkerPreloadRequest, "language" | "theme">) {
  if (typeof language !== "string" || language.length === 0 || language.length > 100) {
    return "Preload language must be a bounded non-empty string.";
  }
  if (typeof theme !== "string" || theme.length === 0 || theme.length > 256) {
    return "Preload theme must be a bounded non-empty string.";
  }
  return undefined;
}

/** Return logical UTF-16 line lengths without adding a line after a terminating newline. */
export function highlightWorkerDocumentLineLengths(text: string) {
  if (text.length === 0) return [];

  const lengths: number[] = [];
  let lineLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lengths.push(lineLength);
      lineLength = 0;
    } else {
      lineLength += 1;
    }
  }
  if (!text.endsWith("\n")) lengths.push(lineLength);
  return lengths;
}

/** Explain why one document request cannot safely enter Shiki, or return undefined. */
export function describeHighlightWorkerDocumentIssue({
  language,
  path,
  text,
  theme,
}: Pick<HighlightWorkerDocumentRequest, "language" | "path" | "text" | "theme">) {
  if (typeof text !== "string" || text.length > MAX_WORKER_DOCUMENT_TEXT_LENGTH) {
    return `Document text exceeds ${MAX_WORKER_DOCUMENT_TEXT_LENGTH} characters.`;
  }
  if (text.includes("\r")) {
    return "Document text must use normalized LF newlines.";
  }

  let lineCount = 0;
  let lineLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lineCount += 1;
      lineLength = 0;
      if (lineCount > MAX_WORKER_DOCUMENT_LINES) {
        return `Document text exceeds ${MAX_WORKER_DOCUMENT_LINES} lines.`;
      }
    } else {
      lineLength += 1;
      if (lineLength >= WORKER_DOCUMENT_TOKENIZE_MAX_LINE_LENGTH) {
        return `Document lines must be shorter than ${WORKER_DOCUMENT_TOKENIZE_MAX_LINE_LENGTH} characters.`;
      }
    }
  }
  if (text.length > 0 && !text.endsWith("\n") && lineCount === MAX_WORKER_DOCUMENT_LINES) {
    return `Document text exceeds ${MAX_WORKER_DOCUMENT_LINES} lines.`;
  }

  if (typeof path !== "string" || path.length === 0 || path.length > 4_096) {
    return "Document path must be a bounded non-empty string.";
  }
  if (typeof language !== "string" || language.length === 0 || language.length > 100) {
    return "Document language must be a bounded non-empty string.";
  }
  if (typeof theme !== "string" || theme.length === 0 || theme.length > 256) {
    return "Document theme must be a bounded non-empty string.";
  }
  return undefined;
}
