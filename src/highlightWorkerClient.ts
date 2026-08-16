/**
 * Resolves the compiled syntax worker from Bun's executable entrypoint context.
 *
 * Keep this root-level shim beside `highlightWorkerEntry.ts`: Bun resolves the additional compiled
 * worker entrypoint from here, while the worker queue and protocol stay under `ui/diff/worker`.
 */
export function createHighlightWorker() {
  return new Worker(new URL("./highlightWorkerEntry.js", import.meta.url).href);
}
