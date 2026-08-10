import type { DiffLineAnnotation, FileDiffMetadata, SupportedLanguages } from "@pierre/diffs";
import type {
  ReviewExpandedContextV1,
  ReviewFileV1,
  ReviewNoteV1,
  ReviewResourceDescriptorV1,
} from "../../core/review/types";
import type { BrowserReviewDocument, BrowserReviewFile } from "./reviewTypes";

export interface PierreReviewFile {
  fileDiff: FileDiffMetadata;
  annotations: Array<DiffLineAnnotation<ReviewNoteV1>>;
  fileNotes: ReviewNoteV1[];
  movedLines: ReviewFileV1["lineMoveKinds"];
  expandedContext: ReviewExpandedContextV1[];
  expandedSourceTextById: Readonly<Record<string, string>>;
  agentSummary?: string;
}

/** Find one generation resource descriptor owned by the requested semantic file. */
export function findReviewResource(
  document: BrowserReviewDocument,
  file: BrowserReviewFile,
  id: string,
): ReviewResourceDescriptorV1 | undefined {
  return document.resources.find(
    (resource) =>
      resource.id === id &&
      resource.fileKey === file.key &&
      resource.generation === document.generation,
  );
}

/** Parse one core-projected canonical file resource without reinterpreting VCS input. */
export function parseCanonicalReviewFile(
  document: BrowserReviewDocument,
  manifestFile: BrowserReviewFile,
  content: string,
): ReviewFileV1 {
  const parsed = JSON.parse(content) as ReviewFileV1;
  if (
    !parsed ||
    parsed.key !== manifestFile.key ||
    parsed.path !== manifestFile.path ||
    parsed.previousPath !== manifestFile.previousPath ||
    parsed.language !== manifestFile.language ||
    parsed.agentSummary !== manifestFile.agentSummary ||
    parsed.canonicalResourceId !== manifestFile.canonicalResourceId ||
    parsed.patchResourceId !== manifestFile.patchResourceId ||
    parsed.changeKind !== manifestFile.changeKind ||
    parsed.stats.additions !== manifestFile.additions ||
    parsed.stats.deletions !== manifestFile.deletions ||
    parsed.stats.truncated !== manifestFile.statsTruncated ||
    JSON.stringify(parsed.flags) !== JSON.stringify(manifestFile.flags) ||
    JSON.stringify(parsed.sourceResourceIds) !== JSON.stringify(manifestFile.sourceResourceIds) ||
    parsed.hunks.length !== manifestFile.hunkCount ||
    parsed.canonicalResourceId !==
      findReviewResource(document, manifestFile, manifestFile.canonicalResourceId)?.id
  ) {
    throw new Error("Canonical review resource does not match its manifest entry.");
  }
  return parsed;
}

/** Reconstruct Pierre input only from the canonical core projection resource. */
export function toPierreReviewFile(
  document: BrowserReviewDocument,
  file: BrowserReviewFile,
  canonicalContent: string,
  mutableNotes: readonly ReviewNoteV1[] = [],
  expandedSourceTextById: Readonly<Record<string, string>> = {},
): PierreReviewFile {
  const canonical = parseCanonicalReviewFile(document, file, canonicalContent);
  const fileDiff: FileDiffMetadata = {
    name: canonical.path,
    ...(canonical.previousPath ? { prevName: canonical.previousPath } : {}),
    ...(canonical.language ? { lang: canonical.language as SupportedLanguages } : {}),
    type: canonical.changeKind,
    hunks: canonical.hunks.map((hunk) => ({
      ...hunk,
      hunkContent: hunk.hunkContent.map((content) => ({ ...content })),
    })),
    splitLineCount: canonical.hunks.reduce(
      (maximum, hunk) => Math.max(maximum, hunk.splitLineStart + hunk.splitLineCount),
      0,
    ),
    unifiedLineCount: canonical.hunks.reduce(
      (maximum, hunk) => Math.max(maximum, hunk.unifiedLineStart + hunk.unifiedLineCount),
      0,
    ),
    isPartial: canonical.flags.partial,
    deletionLines: [...canonical.deletionLines],
    additionLines: [...canonical.additionLines],
    cacheKey: `web:${document.generation}:${canonical.key}`,
  };
  const notes = [...file.notes, ...mutableNotes.filter((note) => note.fileKey === file.key)];
  return {
    fileDiff,
    annotations: notes.flatMap((note) => {
      const anchor = pierreNoteAnchor(file, note, canonical);
      return anchor ? [{ ...anchor, metadata: note }] : [];
    }),
    fileNotes: notes.filter((note) => !pierreNoteAnchor(file, note, canonical)),
    movedLines: canonical.lineMoveKinds,
    expandedContext: canonical.expandedContext.map((entry) => ({ ...entry })),
    expandedSourceTextById,
    agentSummary: canonical.agentSummary,
  };
}

/** Rebase one canonical hunk and its line arrays for an isolated Pierre renderer instance. */
export function isolatePierreHunk(fileDiff: FileDiffMetadata, hunkIndex: number): FileDiffMetadata {
  const hunk = fileDiff.hunks[hunkIndex];
  if (!hunk) throw new Error(`Review hunk ${hunkIndex} does not exist.`);
  const deletionOffset = hunk.deletionLineIndex;
  const additionOffset = hunk.additionLineIndex;
  const isolatedHunk = {
    ...hunk,
    deletionLineIndex: 0,
    additionLineIndex: 0,
    splitLineStart: 0,
    unifiedLineStart: 0,
    hunkContent: hunk.hunkContent.map((content) => ({
      ...content,
      deletionLineIndex: content.deletionLineIndex - deletionOffset,
      additionLineIndex: content.additionLineIndex - additionOffset,
    })),
  };
  return {
    ...fileDiff,
    hunks: [isolatedHunk],
    deletionLines: fileDiff.deletionLines.slice(
      deletionOffset,
      deletionOffset + hunk.deletionCount,
    ),
    additionLines: fileDiff.additionLines.slice(
      additionOffset,
      additionOffset + hunk.additionCount,
    ),
    splitLineCount: hunk.splitLineCount,
    unifiedLineCount: hunk.unifiedLineCount,
    // The sliced arrays are one patch fragment even when the authoritative file resource carried
    // complete before/after documents. Prevent Pierre from treating them as whole-file contents.
    isPartial: true,
    cacheKey: `${fileDiff.cacheKey}:hunk:${hunkIndex}`,
  };
}

/** Anchor inside the core-owned hunk, falling back to its first extant-side code line. */
export function pierreNoteAnchor(
  file: BrowserReviewFile,
  note: ReviewNoteV1,
  canonicalFile?: ReviewFileV1,
): Pick<DiffLineAnnotation<ReviewNoteV1>, "side" | "lineNumber"> | null {
  const ownerIndex = note.anchor.ownerHunkIndex;
  if (ownerIndex === undefined) return null;
  const manifestOwner = file.hunks[ownerIndex];
  const canonicalOwner = canonicalFile?.hunks[ownerIndex];
  if (!manifestOwner) return null;

  const sideRange = (side: "old" | "new"): readonly [number, number] | undefined => {
    if (canonicalOwner) {
      const start = side === "old" ? canonicalOwner.deletionStart : canonicalOwner.additionStart;
      const lines = side === "old" ? canonicalOwner.deletionLines : canonicalOwner.additionLines;
      return lines > 0 ? [start, start + lines - 1] : undefined;
    }
    return side === "old" ? manifestOwner.oldRange : manifestOwner.newRange;
  };

  const preferred = note.anchor.preferred;
  if (preferred) {
    const visibleRange = sideRange(preferred.side);
    const noteRange = preferred.side === "old" ? note.anchor.oldRange : note.anchor.newRange;
    if (visibleRange) {
      const start = noteRange ? Math.max(noteRange[0], visibleRange[0]) : preferred.line;
      const end = noteRange ? Math.min(noteRange[1], visibleRange[1]) : preferred.line;
      if (start <= end) return pierreLineAnchor(preferred.side, start);
    }
  }

  const fallbackSides: Array<"old" | "new"> = [];
  if (preferred) fallbackSides.push(preferred.side);
  fallbackSides.push(file.changeKind === "deleted" ? "old" : "new", "old", "new");
  for (const side of fallbackSides) {
    const range = sideRange(side);
    if (range) return pierreLineAnchor(side, range[0]);
  }
  return null;
}

function pierreLineAnchor(side: "old" | "new", lineNumber: number) {
  return {
    side: side === "old" ? ("deletions" as const) : ("additions" as const),
    lineNumber: Math.max(1, lineNumber),
  };
}
