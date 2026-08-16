/// <reference lib="webworker" />
/**
 * Runs Pierre's whole-file highlight off the main thread for `highlight-worker-offload.ts`.
 *
 * Replies in one of two shapes so the message cost of each can be compared: the raw Pierre HAST,
 * and the compact token encoding from `lib/compactHighlight.ts`. The encoder is shared with the
 * driver so the format the benchmark verifies is the format this worker actually sends.
 *
 * Referenced by URL rather than imported, as `./highlight-worker.js`. That spelling is deliberate:
 * Bun resolves it to this file from source and to the compiled entrypoint inside a `bun build
 * --compile` binary, so one specifier covers both.
 */
import {
  getHighlighterOptions,
  getSharedHighlighter,
  renderDiffWithHighlighter,
  type FileDiffMetadata,
} from "@pierre/diffs";
import {
  columnarTransferList,
  encodeColumnarCode,
  encodeCompactCode,
} from "./lib/compactHighlight";

interface HighlightRequest {
  id: number;
  metadata: FileDiffMetadata;
  language: string;
  theme: string;
  format: "hast" | "compact" | "columnar";
}

const renderOptions = (theme: string) => ({
  theme: theme as "pierre-dark",
  useTokenTransformer: false,
  tokenizeMaxLineLength: 1_000,
  lineDiffType: "word-alt" as const,
  maxLineDiffLength: 10_000,
});

declare const self: Worker;

self.onmessage = async (event: MessageEvent<HighlightRequest>) => {
  const { id, metadata, language, theme, format } = event.data;
  const receivedAt = performance.now();

  const options = getHighlighterOptions(language, { theme: theme as never });
  const highlighter = await getSharedHighlighter({
    ...options,
    preferredHighlighter: "shiki-wasm",
  });
  const readyAt = performance.now();

  const result = renderDiffWithHighlighter(metadata, highlighter, renderOptions(theme));
  const renderedAt = performance.now();

  if (format === "hast") {
    self.postMessage({
      id,
      code: result.code,
      timings: {
        highlighterMs: readyAt - receivedAt,
        renderMs: renderedAt - readyAt,
        encodeMs: 0,
      },
    });
    return;
  }

  if (format === "columnar") {
    const columnar = encodeColumnarCode(result.code);
    // Handing the buffers over rather than copying them is the point of this shape, so the
    // transfer list is not optional.
    self.postMessage(
      {
        id,
        code: columnar,
        timings: {
          highlighterMs: readyAt - receivedAt,
          renderMs: renderedAt - readyAt,
          encodeMs: performance.now() - renderedAt,
        },
      },
      columnarTransferList(columnar),
    );
    return;
  }

  const code = encodeCompactCode(result.code);

  self.postMessage({
    id,
    code,
    timings: {
      highlighterMs: readyAt - receivedAt,
      renderMs: renderedAt - readyAt,
      encodeMs: performance.now() - renderedAt,
    },
  });
};
