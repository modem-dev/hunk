/** Exposes the terminal diff worker subsystem without requiring callers to know its internals. */
export {
  createHighlightWorker,
  supportsHighlightWorkerOffload,
} from "../../../highlightWorkerClient";
export {
  disposeHighlightWorker,
  highlightDiffInWorker,
  highlightDocumentInWorker,
  registerHighlightWorker,
  HighlightWorkerClientError,
  type HighlightWorkerClientErrorCode,
  type WorkerHighlightedDiffCode,
  type WorkerHighlightedDocumentCode,
} from "./highlightWorkerClient";
export {
  documentWorkerEligibility,
  type DocumentWorkerEligibility,
  type DocumentWorkerHighlightInput,
} from "./documentWorkerEligibility";
export {
  compactHighlightRunsForLine,
  compactHighlightTransferList,
  compactHighlightedDiffByteLength,
  compactHighlightedDocumentByteLength,
  compactHighlightedDocumentRunsForLine,
  compactHighlightedDocumentTransferList,
  cloneCompactHighlightedDocument,
  encodeCompactHighlightedDiff,
  encodeCompactHighlightedDocument,
  validateCompactHighlightedDiff,
  validateCompactHighlightedDocument,
  type CompactDocumentHighlightRun,
  type CompactHighlightedDiff,
  type CompactHighlightedDocument,
  type CompactHighlightRun,
} from "./highlightCompact";
export { aliasContextHighlightLines } from "./highlightContext";
export { collectHastHighlightRuns, type HastNode } from "./highlightHast";
