/** Exposes the terminal diff worker subsystem without requiring callers to know its internals. */
export {
  createHighlightWorker,
  supportsHighlightWorkerOffload,
} from "../../../highlightWorkerClient";
export {
  disposeHighlightWorker,
  highlightDiffInWorker,
  registerHighlightWorker,
  type WorkerHighlightedDiffCode,
} from "./highlightWorkerClient";
export {
  compactHighlightRunsForLine,
  compactHighlightTransferList,
  compactHighlightedDiffByteLength,
  encodeCompactHighlightedDiff,
  validateCompactHighlightedDiff,
  type CompactHighlightedDiff,
  type CompactHighlightRun,
} from "./highlightCompact";
export { aliasContextHighlightLines } from "./highlightContext";
export { collectHastHighlightRuns, type HastNode } from "./highlightHast";
