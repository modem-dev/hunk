/**
 * Executes one validated worker request through Pierre and returns compact transferable ranges.
 *
 * Complete documents render in one call so TextMate state crosses multiline strings and comments.
 * Theme registration and terminal projection remain main-thread concerns.
 */
import {
  getHighlighterOptions,
  getSharedHighlighter,
  renderDiffWithHighlighter,
  renderFileWithHighlighter,
} from "@pierre/diffs";
import { aliasContextHighlightLines } from "./highlightContext";
import {
  cloneCompactHighlightedDiff,
  cloneCompactHighlightedDocument,
  encodeCompactHighlightedDiff,
  encodeCompactHighlightedDocument,
  validateCompactHighlightedDiff,
  validateCompactHighlightedDocument,
  type CompactHighlightedDiff,
  type CompactHighlightedDocument,
  type HighlightedHastLines,
} from "./highlightCompact";
import { HighlightWorkerCache, type HighlightWorkerCachePayload } from "./highlightWorkerCache";
import {
  highlightWorkerCacheKey,
  type HighlightWorkerCacheIdentity,
} from "./highlightWorkerIdentity";
import {
  describeHighlightWorkerDocumentIssue,
  highlightWorkerDocumentLineLengths,
  HIGHLIGHT_WORKER_PROTOCOL_VERSION,
  WORKER_DOCUMENT_TOKENIZE_MAX_LINE_LENGTH,
  type HighlightWorkerFailure,
  type HighlightWorkerRequest,
  type HighlightWorkerResponse,
} from "./highlightWorkerProtocol";

/** Build the fixed Pierre render options shared with the terminal highlighter. */
function workerRenderOptions(theme: string) {
  return {
    theme: theme as "pierre-dark",
    useTokenTransformer: false,
    tokenizeMaxLineLength: WORKER_DOCUMENT_TOKENIZE_MAX_LINE_LENGTH,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: 10_000,
  };
}

/** Convert an unknown thrown value into a reply that survives structured clone. */
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Match the public code-document model by dropping Pierre's trailing placeholder line. */
function normalizedHighlightedDocumentLines(text: string, lines: HighlightedHastLines) {
  if (text.length === 0) return [];
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

/** Return a protocol-shaped failure even when a malformed sender omitted envelope fields. */
function failureResponse(request: unknown, message: string): HighlightWorkerFailure {
  const envelope = request && typeof request === "object" ? request : {};
  return {
    version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
    id: "id" in envelope && typeof envelope.id === "number" ? envelope.id : -1,
    kind: "kind" in envelope && envelope.kind === "document" ? "document" : "diff",
    ok: false,
    message,
  };
}

/** Validate the request envelope before Pierre observes any caller-controlled fields. */
function validateRequest(request: unknown): asserts request is HighlightWorkerRequest {
  if (!request || typeof request !== "object") {
    throw new Error("Highlight worker request must be an object.");
  }
  const candidate = request as Record<string, unknown>;
  if (candidate.version !== HIGHLIGHT_WORKER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported highlight worker protocol version: ${String(candidate.version)}`);
  }
  if (!Number.isSafeInteger(candidate.id) || (candidate.id as number) < 0) {
    throw new Error("Highlight worker request has an invalid id.");
  }
  if (candidate.kind !== "diff" && candidate.kind !== "document") {
    throw new Error("Highlight worker request has an invalid kind.");
  }
  if (candidate.appearance !== "dark" && candidate.appearance !== "light") {
    throw new Error("Highlight worker request has an invalid appearance.");
  }
  if (
    typeof candidate.language !== "string" ||
    candidate.language.length === 0 ||
    typeof candidate.theme !== "string" ||
    candidate.theme.length === 0
  ) {
    throw new Error("Highlight worker request has invalid syntax inputs.");
  }
  if (candidate.kind === "diff") {
    if (
      typeof candidate.aliasContext !== "boolean" ||
      !candidate.metadata ||
      typeof candidate.metadata !== "object" ||
      Array.isArray(candidate.metadata)
    ) {
      throw new Error("Highlight worker diff request is malformed.");
    }
  } else {
    const issue = describeHighlightWorkerDocumentIssue({
      language: candidate.language as string,
      path: candidate.path as string,
      text: candidate.text as string,
      theme: candidate.theme as string,
    });
    if (issue) throw new Error(issue);
  }
}

/** Return whether a cache payload matches its request's response kind. */
function payloadMatchesKind(
  payload: HighlightWorkerCachePayload,
  kind: HighlightWorkerRequest["kind"],
) {
  return kind === "document" ? "document" in payload : "deletion" in payload;
}

/** Render one cache miss into a validated compact payload. */
async function renderRequest(request: HighlightWorkerRequest, cacheKey: string) {
  const highlighter = await getSharedHighlighter({
    ...getHighlighterOptions(request.language, {
      theme: request.theme as never,
    }),
    preferredHighlighter: "shiki-wasm",
  });

  if (request.kind === "diff") {
    const result = renderDiffWithHighlighter(
      request.metadata,
      highlighter,
      workerRenderOptions(request.theme),
    );
    const highlighted = result.code as {
      deletionLines: HighlightedHastLines;
      additionLines: HighlightedHastLines;
    };
    const payload = encodeCompactHighlightedDiff(
      request.aliasContext
        ? aliasContextHighlightLines(request.metadata, highlighted)
        : highlighted,
      request.appearance,
    );
    validateCompactHighlightedDiff(payload);
    return payload;
  }

  const result = renderFileWithHighlighter(
    {
      name: request.path,
      contents: request.text,
      lang: request.language as never,
      cacheKey,
    },
    highlighter,
    workerRenderOptions(request.theme),
  );
  const payload = encodeCompactHighlightedDocument(
    normalizedHighlightedDocumentLines(request.text, result.code as HighlightedHastLines),
    request.appearance,
  );
  validateCompactHighlightedDocument(payload, highlightWorkerDocumentLineLengths(request.text));
  return payload;
}

/** Process one private worker message with shared byte-bounded cache ownership. */
export async function processHighlightWorkerRequest(
  value: unknown,
  cache: HighlightWorkerCache,
): Promise<HighlightWorkerResponse> {
  try {
    validateRequest(value);
    const request = value;
    const { id, version: _version, ...identity } = request;
    const cacheKey = highlightWorkerCacheKey(identity as HighlightWorkerCacheIdentity);

    let code = cache.get(cacheKey);
    if (code && !payloadMatchesKind(code, request.kind)) {
      throw new Error("Highlight worker cache returned the wrong payload kind.");
    }
    if (!code) {
      const cachedCode = await renderRequest(request, cacheKey);
      // Oversized payloads stay uncached and transfer their only copy, avoiding a temporary
      // second typed-array payload that would violate the worker cache's memory bound.
      code = cache.set(cacheKey, cachedCode)
        ? request.kind === "document"
          ? cloneCompactHighlightedDocument(cachedCode as CompactHighlightedDocument)
          : cloneCompactHighlightedDiff(cachedCode as CompactHighlightedDiff)
        : cachedCode;
    }

    if (request.kind === "document") {
      return {
        version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
        id,
        kind: "document",
        ok: true,
        code: code as CompactHighlightedDocument,
      };
    }
    return {
      version: HIGHLIGHT_WORKER_PROTOCOL_VERSION,
      id,
      kind: "diff",
      ok: true,
      code: code as CompactHighlightedDiff,
    };
  } catch (error) {
    return failureResponse(value, errorMessage(error));
  }
}
