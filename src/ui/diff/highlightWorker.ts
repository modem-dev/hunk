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

interface HighlightWorkerRequest {
  version: 1;
  id: number;
  metadata: FileDiffMetadata;
  language: string;
  theme: string;
}

type HighlightWorkerResponse =
  | {
      version: 1;
      id: number;
      ok: true;
      code: { deletionLines: unknown[]; additionLines: unknown[] };
    }
  | { version: 1; id: number; ok: false; message: string };

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
  const { id, language, metadata, theme, version } = event.data;

  if (version !== 1) {
    const response: HighlightWorkerResponse = {
      version: 1,
      id,
      ok: false,
      message: `Unsupported highlight worker protocol version: ${String(version)}`,
    };
    self.postMessage(response);
    return;
  }

  try {
    const options = getHighlighterOptions(language, { theme: theme as never });
    const highlighter = await getSharedHighlighter({
      ...options,
      preferredHighlighter: "shiki-wasm",
    });
    const result = renderDiffWithHighlighter(metadata, highlighter, workerRenderOptions(theme));
    const response: HighlightWorkerResponse = {
      version: 1,
      id,
      ok: true,
      code: result.code,
    };
    self.postMessage(response);
  } catch (error) {
    const response: HighlightWorkerResponse = {
      version: 1,
      id,
      ok: false,
      message: errorMessage(error),
    };
    self.postMessage(response);
  }
};
