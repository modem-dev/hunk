/** Resolve the worker URL once so capability checks and construction inspect the same path. */
function highlightWorkerUrl() {
  return new URL("./highlightWorkerEntry.js", import.meta.url);
}

/** Return whether this runtime can resolve Hunk's syntax worker entrypoint. */
export function supportsHighlightWorkerOffload({
  platform = process.platform,
  workerUrl = highlightWorkerUrl().href,
}: {
  platform?: NodeJS.Platform;
  workerUrl?: string;
} = {}) {
  // Bun 1.3 cannot resolve embedded Worker entrypoints from Windows single-file executables.
  // Source-mode Windows workers still work, so disable only the B:\~BUN virtual-filesystem case.
  const normalizedWorkerUrl = workerUrl.replaceAll("\\", "/").toLowerCase();
  return platform !== "win32" || !normalizedWorkerUrl.includes("/~bun/");
}

/**
 * Resolves the compiled syntax worker from Bun's executable entrypoint context.
 *
 * Keep this root-level shim beside `highlightWorkerEntry.ts`: Bun resolves the additional compiled
 * worker entrypoint from here, while the worker queue and protocol stay under `ui/diff/worker`.
 */
export function createHighlightWorker() {
  const workerUrl = highlightWorkerUrl();
  if (!supportsHighlightWorkerOffload({ workerUrl: workerUrl.href })) {
    throw new Error("Syntax worker offload is unavailable in Bun's compiled Windows runtime.");
  }
  return new Worker(workerUrl);
}
