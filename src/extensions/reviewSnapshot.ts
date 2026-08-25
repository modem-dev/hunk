/**
 * Projects shared review state into the immutable public snapshot extensions consume.
 *
 * The projection copies authoritative file identities, note fields, and resolved anchors;
 * it never re-derives placement or freezes objects owned by ReviewStore. Complete saved-note
 * ordering comes from the shared selector, including stale and orphaned entries.
 */
import { selectStoredReviewNotes } from "../core/review/selectors";
import type { ReviewStoredNote, ReviewState } from "../core/review/state";
import type {
  ExtensionReviewSnapshot,
  ExtensionReviewSnapshotFile,
  ExtensionReviewSnapshotNote,
  ExtensionReviewSnapshotNoteAnchor,
} from "../extension-api/types";

/** Copy one optional inclusive line range into a frozen public tuple. */
function copyRange(range: readonly [number, number] | undefined) {
  return range ? Object.freeze([range[0], range[1]] as const) : undefined;
}

/** Copy one resolved note anchor without interpreting its placement. */
function projectAnchor(note: ReviewStoredNote): ExtensionReviewSnapshotNoteAnchor {
  const { anchor } = note.note;
  return Object.freeze({
    ...(anchor.oldRange ? { oldRange: copyRange(anchor.oldRange) } : {}),
    ...(anchor.newRange ? { newRange: copyRange(anchor.newRange) } : {}),
    ...(anchor.preferred
      ? {
          preferred: Object.freeze({
            side: anchor.preferred.side,
            line: anchor.preferred.line,
          }),
        }
      : {}),
    intersectingHunkIndices: Object.freeze([...anchor.intersectingHunkIndices]),
    ...(anchor.ownerHunkIndex !== undefined ? { ownerHunkIndex: anchor.ownerHunkIndex } : {}),
  });
}

/** Copy one stored note and its reconciliation verdict into the public contract. */
function projectNote(entry: ReviewStoredNote): ExtensionReviewSnapshotNote {
  const note = entry.note;
  return Object.freeze({
    id: note.id,
    source: note.source,
    ...(note.originalSource !== undefined ? { originalSource: note.originalSource } : {}),
    fileKey: note.fileKey,
    anchor: projectAnchor(entry),
    summary: note.summary,
    ...(note.rationale !== undefined ? { rationale: note.rationale } : {}),
    ...(note.markup !== undefined ? { markup: note.markup } : {}),
    ...(note.title !== undefined ? { title: note.title } : {}),
    ...(note.author !== undefined ? { author: note.author } : {}),
    ...(note.createdAt !== undefined ? { createdAt: note.createdAt } : {}),
    ...(note.updatedAt !== undefined ? { updatedAt: note.updatedAt } : {}),
    editable: note.editable,
    ...(note.tags !== undefined ? { tags: Object.freeze([...note.tags]) } : {}),
    ...(note.confidence !== undefined ? { confidence: note.confidence } : {}),
    resolution: entry.resolution,
  });
}

/** Copy one semantic file address and exporter-relevant status into the public contract. */
function projectFile(file: ReviewState["document"]["files"][number]): ExtensionReviewSnapshotFile {
  return Object.freeze({
    fileKey: file.key,
    runtimeId: file.runtimeId,
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    changeKind: file.changeKind,
    stats: Object.freeze({ ...file.stats }),
    flags: Object.freeze({ ...file.flags }),
    contentIdentity: file.contentIdentity,
    ...(file.sourceIdentity !== undefined ? { sourceIdentity: file.sourceIdentity } : {}),
    ...(file.sourceAttested !== undefined ? { sourceAttested: file.sourceAttested } : {}),
  });
}

/** Build one deeply immutable extension snapshot from the current authoritative state. */
export function buildExtensionReviewSnapshot(
  generation: string,
  state: ReviewState,
): ExtensionReviewSnapshot {
  return Object.freeze({
    generation,
    stateRevision: state.stateRevision,
    files: Object.freeze(state.document.files.map(projectFile)),
    notes: Object.freeze(selectStoredReviewNotes(state).map(projectNote)),
  });
}
