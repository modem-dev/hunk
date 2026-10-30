/** Resolve the worker URL once so capability checks and construction inspect the same path. */
function highlightWorkerUrl() {
  return new URL("./highlightWorkerEntry.js", import.meta.url);
}

/** Return whether this runtime can resolve Hunk's syntax worker entrypoint. */
export function supportsHighlightWorkerOffload({
  execPath = process.execPath,
  platform = process.platform,
}: {
  execPath?: string;
  platform?: NodeJS.Platform;
} = {}) {
  // Bun 1.3 cannot resolve embedded Worker entrypoints from Windows single-file executables.
  // Source-mode Windows runs through bun.exe; compiled Hunk runs through its own executable.
  const executableName = execPath.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  const runsThroughBun = executableName === "bun" || executableName === "bun.exe";
  return platform !== "win32" || runsThroughBun;
}

/**
 * Resolves the compiled syntax worker from Bun's executable entrypoint context.
 *
 * Keep this root-level shim beside `highlightWorkerEntry.ts`: Bun resolves the additional compiled
 * worker entrypoint from here, while the worker queue and protocol stay under `ui/diff/worker`.
 */
export function createHighlightWorker() {
  const workerUrl = highlightWorkerUrl();
  if (!supportsHighlightWorkerOffload()) {
    throw new Error("Syntax worker offload is unavailable in Bun's compiled Windows runtime.");
  }
  return new Worker(workerUrl);
}
