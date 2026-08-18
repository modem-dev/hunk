import type { DiffFile } from "../../core/changeset/model";
import type {
  ExtensionDiffFile,
  ExtensionFileChangeRange,
  ExtensionFileViewInput,
} from "../../extension-api/types";
import { readMetadataHunkSummaries, toReadOnlyFileViews } from "../../extensions/events";
import { createExtensionDocumentReader } from "../lib/extensionDocumentReader";

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
  return Object.freeze({
    file: snapshot.file,
    width,
    signal,
    changes: snapshot.changes,
    readDocument: createExtensionDocumentReader(file, signal),
  });
}

/** Read the hunk count through the public conversion boundary. */
export function fileViewHunkCount(file: DiffFile) {
  return readMetadataHunkSummaries(file.metadata).length;
}
