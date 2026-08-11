import type { ReviewNoteV1 } from "../core/review/types";
import type {
  HunkReviewManifestFileV1,
  HunkReviewManifestV1,
  HunkReviewStateV1,
} from "./reviewProtocol";
import type { SessionLiveCommentSummary, SessionReviewNoteSummary } from "./types";

const staticReviewNoteSummaryCache = new WeakMap<
  ReviewNoteV1,
  Map<string, SessionReviewNoteSummary>
>();

/** Project one canonical note into the legacy review-note compatibility shape. */
function projectReviewNoteSummary(
  note: ReviewNoteV1,
  file: Pick<HunkReviewManifestFileV1, "path">,
): SessionReviewNoteSummary {
  return {
    noteId: note.id,
    source: note.source,
    filePath: file.path,
    ...(note.anchor.ownerHunkIndex !== undefined ? { hunkIndex: note.anchor.ownerHunkIndex } : {}),
    ...(note.anchor.oldRange ? { oldRange: [...note.anchor.oldRange] as [number, number] } : {}),
    ...(note.anchor.newRange ? { newRange: [...note.anchor.newRange] as [number, number] } : {}),
    body: [note.summary, note.rationale].filter(Boolean).join("\n\n"),
    ...(note.title !== undefined ? { title: note.title } : {}),
    ...(note.author !== undefined ? { author: note.author } : {}),
    createdAt: note.createdAt ?? "1970-01-01T00:00:00.000Z",
    ...(note.updatedAt !== undefined ? { updatedAt: note.updatedAt } : {}),
    editable: note.editable,
  };
}

/** Reuse immutable manifest-note summaries without changing their file-local ordering. */
function projectStaticReviewNoteSummary(
  note: ReviewNoteV1,
  file: Pick<HunkReviewManifestFileV1, "path">,
) {
  const byPath = staticReviewNoteSummaryCache.get(note) ?? new Map();
  const cached = byPath.get(file.path);
  if (cached) return cached;
  const projected = projectReviewNoteSummary(note, file);
  byPath.set(file.path, projected);
  staticReviewNoteSummaryCache.set(note, byPath);
  return projected;
}

/** Project one live-agent note into the legacy live-comment compatibility shape. */
function projectLiveCommentSummary(
  note: ReviewNoteV1,
  file: Pick<HunkReviewManifestFileV1, "path">,
): SessionLiveCommentSummary | null {
  const preferred = note.anchor.preferred;
  if (note.origin !== "live-agent" || !preferred) return null;
  return {
    commentId: note.id,
    filePath: file.path,
    hunkIndex: note.anchor.ownerHunkIndex ?? 0,
    side: preferred.side,
    line: preferred.line,
    summary: note.summary,
    ...(note.rationale !== undefined ? { rationale: note.rationale } : {}),
    ...(note.author !== undefined ? { author: note.author } : {}),
    createdAt: note.createdAt ?? "1970-01-01T00:00:00.000Z",
  };
}

/** Derive every compatibility note projection from canonical manifest and mutable state notes. */
export function projectReviewCompatibility(
  files: readonly Pick<HunkReviewManifestFileV1, "key" | "path" | "notes">[],
  mutableNotes: readonly ReviewNoteV1[],
) {
  const mutableByFile = new Map<string, ReviewNoteV1[]>();
  for (const note of mutableNotes) {
    const entries = mutableByFile.get(note.fileKey) ?? [];
    entries.push(note);
    mutableByFile.set(note.fileKey, entries);
  }

  const reviewNotes: SessionReviewNoteSummary[] = [];
  const liveComments: SessionLiveCommentSummary[] = [];
  for (const file of files) {
    for (const note of file.notes) {
      reviewNotes.push(projectStaticReviewNoteSummary(note, file));
    }
    for (const note of mutableByFile.get(file.key) ?? []) {
      reviewNotes.push(projectReviewNoteSummary(note, file));
    }
    for (const note of mutableByFile.get(file.key) ?? []) {
      const comment = projectLiveCommentSummary(note, file);
      if (comment) liveComments.push(comment);
    }
  }
  return { reviewNotes, liveComments };
}

/** Derive compatibility projections from one atomic review manifest/state pair. */
export function projectManifestReviewCompatibility(
  manifest: HunkReviewManifestV1,
  state: HunkReviewStateV1,
) {
  return projectReviewCompatibility(manifest.files, state.notes);
}
