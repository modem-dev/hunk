/// <reference lib="webworker" />
/**
 * Highlights diff metadata away from the terminal event loop.
 *
 * This worker accepts only bundled Pierre themes. The main thread keeps custom-theme registration,
 * source loading, result mapping, and every terminal rendering concern local.
 */
import {
  getHighlighterOptions,
  getSharedHighlighter,
  renderDiffWithHighlighter,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { aliasContextHighlightLines } from "./highlightContext";
import {
  cloneCompactHighlightedDiff,
  compactHighlightTransferList,
  encodeCompactHighlightedDiff,
  type CompactHighlightedDiff,
  type HighlightedHastLines,
} from "./highlightCompact";
import { HighlightWorkerCache } from "./highlightWorkerCache";
import { highlightWorkerCacheKey } from "./highlightWorkerIdentity";

interface HighlightWorkerRequest {
  version: 3;
  id: number;
  aliasContext: boolean;
  metadata: FileDiffMetadata;
  appearance: "dark" | "light";
  language: string;
  theme: string;
}

type HighlightWorkerResponse =
  | {
      version: 3;
      id: number;
      ok: true;
      code: CompactHighlightedDiff;
    }
  | { version: 3; id: number; ok: false; message: string };

const highlightedDiffCache = new HighlightWorkerCache();

/** Build the fixed Pierre render options shared with the terminal highlighter. */
function workerRenderOptions(theme: string) {
  return {
    theme: theme as "pierre-dark",
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1_000,
    lineDiffType: "word-alt" as const,
    maxLineDiffLength: 10_000,
  };
}

/** Convert an unknown thrown value into a reply that survives structured clone. */
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

declare const self: Worker;

self.onmessage = async (event: MessageEvent<HighlightWorkerRequest>) => {
  const { aliasContext, appearance, id, language, metadata, theme, version } = event.data;

  if (version !== 3) {
    const response: HighlightWorkerResponse = {
      version: 3,
      id,
      ok: false,
      message: `Unsupported highlight worker protocol version: ${String(version)}`,
    };
    self.postMessage(response);
    return;
  }

  try {
    const cacheKey = highlightWorkerCacheKey({
      aliasContext,
      appearance,
      language,
      metadata,
      theme,
    });
    // A transferred response detaches its buffers. Cache hits therefore return a fresh typed-array
    // copy, while the worker retains its own compact payload for a later request.
    let code = highlightedDiffCache.get(cacheKey);
    if (!code) {
      const highlighter = await getSharedHighlighter({
        ...getHighlighterOptions(language, { theme: theme as never }),
        preferredHighlighter: "shiki-wasm",
      });
      const result = renderDiffWithHighlighter(metadata, highlighter, workerRenderOptions(theme));
      const highlighted = result.code as {
        deletionLines: HighlightedHastLines;
        additionLines: HighlightedHastLines;
      };
      const cachedCode = encodeCompactHighlightedDiff(
        aliasContext ? aliasContextHighlightLines(metadata, highlighted) : highlighted,
        appearance,
      );

      // Oversized payloads stay uncached and transfer their only copy, avoiding a temporary
      // second typed-array payload that would violate the worker cache's memory bound.
      code = highlightedDiffCache.set(cacheKey, cachedCode)
        ? cloneCompactHighlightedDiff(cachedCode)
        : cachedCode;
    }

    const response: HighlightWorkerResponse = {
      version: 3,
      id,
      ok: true,
      code,
    };
    self.postMessage(response, compactHighlightTransferList(code));
  } catch (error) {
    const response: HighlightWorkerResponse = {
      version: 3,
      id,
      ok: false,
      message: errorMessage(error),
    };
    self.postMessage(response);
  }
};
