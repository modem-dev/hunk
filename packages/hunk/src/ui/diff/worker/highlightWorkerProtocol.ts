import type { FileDiffMetadata } from "@pierre/diffs";
import type { CompactHighlightedDiff, CompactHighlightedDocument } from "./highlightCompact";

/** Identifies the private main-thread/worker message contract. */
export const HIGHLIGHT_WORKER_PROTOCOL_VERSION = 4;

/** Bounds one complete document before it enters the worker queue. */
export const MAX_WORKER_DOCUMENT_TEXT_LENGTH = 1_000_000;
export const MAX_WORKER_DOCUMENT_LINES = 10_000;
/** Pierre skips tokenization at this length, so document jobs fall back instead of losing state. */
export const WORKER_DOCUMENT_TOKENIZE_MAX_LINE_LENGTH = 1_000;

interface HighlightWorkerRequestBase {
  version: typeof HIGHLIGHT_WORKER_PROTOCOL_VERSION;
  id: number;
  appearance: "dark" | "light";
  language: string;
  theme: string;
}

/** Requests Pierre diff rendering with optional complete-source context aliases. */
export interface HighlightWorkerDiffRequest extends HighlightWorkerRequestBase {
  kind: "diff";
  aliasContext: boolean;
  metadata: FileDiffMetadata;
}

/** Requests complete-document rendering so TextMate lexical state spans every line. */
export interface HighlightWorkerDocumentRequest extends HighlightWorkerRequestBase {
  kind: "document";
  path: string;
  text: string;
}

export type HighlightWorkerRequest = HighlightWorkerDiffRequest | HighlightWorkerDocumentRequest;

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

export type HighlightWorkerSuccess = HighlightWorkerDiffSuccess | HighlightWorkerDocumentSuccess;

export interface HighlightWorkerFailure extends HighlightWorkerResponseBase {
  kind: HighlightWorkerRequest["kind"];
  ok: false;
  message: string;
}

export type HighlightWorkerResponse = HighlightWorkerSuccess | HighlightWorkerFailure;

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
