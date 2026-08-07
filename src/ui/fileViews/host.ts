import type { DiffFile } from "../../core/types";
import type {
  ExtensionDiffFile,
  ExtensionFileChangeRange,
  ExtensionFileSide,
  ExtensionFileViewInput,
} from "../../extension-api/types";
import { readMetadataHunkSummaries, toReadOnlyFileViews } from "../../extensions/events";

/** Abort one caller's wait without cancelling the host's shared source read. */
function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("The file-view request was aborted.", "AbortError"));
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new DOMException("The file-view request was aborted.", "AbortError"));
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

/** Build public added/removed ranges from parsed hunks, without leaking Pierre types. */
export function fileViewChanges(file: DiffFile): readonly ExtensionFileChangeRange[] {
  const changes: ExtensionFileChangeRange[] = [];
  for (const [hunkIndex, hunk] of file.metadata.hunks.entries()) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const chunk of hunk.hunkContent) {
      if (chunk.type === "context") {
        oldLine += chunk.lines;
        newLine += chunk.lines;
        continue;
      }
      if (chunk.deletions > 0) {
        changes.push({
          hunkIndex,
          kind: "removed",
          range: [oldLine, oldLine + chunk.deletions - 1],
        });
      }
      if (chunk.additions > 0) {
        changes.push({
          hunkIndex,
          kind: "added",
          range: [newLine, newLine + chunk.additions - 1],
        });
      }
      oldLine += chunk.deletions;
      newLine += chunk.additions;
    }
  }
  return Object.freeze(
    changes.map((change) =>
      Object.freeze({
        ...change,
        range: Object.freeze([...change.range]) as readonly [number, number],
      }),
    ),
  );
}

/** Immutable public file data derived once for matching and layout. */
export interface FileViewInputSnapshot {
  readonly file: ExtensionDiffFile;
  readonly changes: readonly ExtensionFileChangeRange[];
}

/** Derive immutable file data shared by matching and one subsequent layout request. */
export function createFileViewInputSnapshot(file: DiffFile): FileViewInputSnapshot {
  return Object.freeze({
    file: toReadOnlyFileViews([file])[0]!,
    changes: fileViewChanges(file),
  });
}

/** Build the frozen public input for one layout request from reusable immutable file data. */
export function createFileViewInput(
  file: DiffFile,
  width: number,
  signal: AbortSignal,
  snapshot: FileViewInputSnapshot = createFileViewInputSnapshot(file),
): ExtensionFileViewInput {
  const reads = new Map<ExtensionFileSide, Promise<string | null>>();
  return Object.freeze({
    file: snapshot.file,
    width,
    signal,
    changes: snapshot.changes,
    readDocument(side: ExtensionFileSide) {
      let read = reads.get(side);
      if (!read) {
        read = file.sourceFetcher
          ? file.sourceFetcher.getFullText(side).catch(() => null)
          : Promise.resolve(null);
        reads.set(side, read);
      }
      return waitWithSignal(read, signal);
    },
  });
}

/** Read the hunk count through the public conversion boundary. */
export function fileViewHunkCount(file: DiffFile) {
  return readMetadataHunkSummaries(file.metadata).length;
}
