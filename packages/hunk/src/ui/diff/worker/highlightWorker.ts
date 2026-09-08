/// <reference lib="webworker" />
/**
 * Highlights diff metadata and complete code documents away from the terminal event loop.
 *
 * This worker accepts only themes already resolvable by Pierre. The main thread keeps custom-theme
 * registration, source loading, result mapping, and every terminal rendering concern local.
 */
import {
  compactHighlightTransferList,
  compactHighlightedDocumentTransferList,
} from "./highlightCompact";
import { HighlightWorkerCache } from "./highlightWorkerCache";
import type { HighlightWorkerResponse } from "./highlightWorkerProtocol";
import { processHighlightWorkerRequest } from "./highlightWorkerRuntime";

const highlightCache = new HighlightWorkerCache();

declare const self: Worker;

/** Return the numeric buffers owned by one successful response. */
function responseTransferList(response: HighlightWorkerResponse) {
  if (!response.ok) return [];
  return response.kind === "document"
    ? compactHighlightedDocumentTransferList(response.code)
    : compactHighlightTransferList(response.code);
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  const response = await processHighlightWorkerRequest(event.data, highlightCache);
  self.postMessage(response, responseTransferList(response));
};
