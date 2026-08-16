/** Return whether this runtime can resolve Hunk's syntax worker entrypoint. */
export function supportsHighlightWorkerOffload({
  moduleUrl = import.meta.url,
  platform = process.platform,
}: {
  moduleUrl?: string;
  platform?: NodeJS.Platform;
} = {}) {
  // Bun 1.3 cannot resolve embedded Worker entrypoints from Windows single-file executables.
  // Source-mode Windows workers still work, so disable only the B:\~BUN virtual-filesystem case.
  const normalizedModuleUrl = moduleUrl.replaceAll("\\", "/").toLowerCase();
  return platform !== "win32" || !normalizedModuleUrl.includes("/~bun/");
}

/**
 * Resolves the compiled syntax worker from Bun's executable entrypoint context.
 *
 * Keep this root-level shim beside `highlightWorkerEntry.ts`: Bun resolves the additional compiled
 * worker entrypoint from here, while the worker queue and protocol stay under `ui/diff/worker`.
 */
export function createHighlightWorker() {
  if (!supportsHighlightWorkerOffload()) {
    throw new Error("Syntax worker offload is unavailable in Bun's compiled Windows runtime.");
  }
  return new Worker(new URL("./highlightWorkerEntry.js", import.meta.url));
}
