/** Re-export the Bun entrypoint-aware worker client for terminal diff rendering. */
export {
  disposeHighlightWorker,
  highlightDiffInWorker,
  registerHighlightWorker,
  type WorkerHighlightedDiffCode,
} from "../../highlightWorkerClient";
