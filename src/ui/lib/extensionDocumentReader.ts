import type { DiffFile } from "../../core/changeset/model";
import type { ExtensionFileSide } from "../../extension-api/types";

/** Abort one caller's wait without cancelling the host's shared source read. */
function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("The extension request was aborted.", "AbortError"));
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new DOMException("The extension request was aborted.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * Build the shared `readDocument(side)` capability handed to extension inputs.
 *
 * Reads are deduplicated per side for the lifetime of one request, resolve
 * `null` for any unreadable side, and respect the request's abort signal
 * without cancelling the host's underlying source read.
 */
export function createExtensionDocumentReader(file: DiffFile, signal: AbortSignal) {
  const reads = new Map<ExtensionFileSide, Promise<string | null>>();
  return (side: ExtensionFileSide) => {
    let read = reads.get(side);
    if (!read) {
      read = file.sourceFetcher
        ? file.sourceFetcher.getFullText(side).catch(() => null)
        : Promise.resolve(null);
      reads.set(side, read);
    }
    return waitWithSignal(read, signal);
  };
}
