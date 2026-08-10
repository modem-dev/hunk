import { reviewGapAddress } from "./expansion";
import { reviewDigest } from "./identity";
import { reviewFileMatchesFilter } from "./selectors";
import type {
  ReviewDraftNote,
  ReviewExpandedGapState,
  ReviewSemanticSelection,
  ReviewState,
  ReviewStoredNote,
  ReviewStoredNoteAddress,
} from "./state";
import type {
  ReviewDocumentV1,
  ReviewFileV1,
  ReviewHunkV1,
  ReviewLineRange,
  ReviewRangeAnchorV1,
  ReviewSide,
} from "./types";

/** Return the inclusive semantic range occupied by one hunk on one side. */
export function reviewHunkRange(hunk: ReviewHunkV1, side: ReviewSide) {
  const start = side === "new" ? hunk.additionStart : hunk.deletionStart;
  const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
  return [start, Math.max(start, start + Math.max(count, 1) - 1)] as const;
}

/** Map one absolute semantic line to its compact patch-array address. */
export function reviewLineAddress(file: ReviewFileV1, side: ReviewSide, line: number) {
  for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
    const hunk = file.hunks[hunkIndex]!;
    const start = side === "new" ? hunk.additionStart : hunk.deletionStart;
    const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
    const lineIndex = side === "new" ? hunk.additionLineIndex : hunk.deletionLineIndex;
    if (count <= 0 || line < start || line >= start + count) continue;
    const arrayIndex = file.flags.partial ? lineIndex + line - start : line - 1;
    const lines = side === "new" ? file.additionLines : file.deletionLines;
    if (arrayIndex < 0 || arrayIndex >= lines.length) return undefined;
    return { hunkIndex, arrayIndex };
  }
  return undefined;
}

/** Enumerate absolute semantic lines backed by one side's compact patch arrays. */
function reviewSemanticLines(file: ReviewFileV1, side: ReviewSide) {
  if (!file.flags.partial) {
    const lines = side === "new" ? file.additionLines : file.deletionLines;
    return Array.from({ length: lines.length }, (_, index) => index + 1);
  }
  return file.hunks.flatMap((hunk) => {
    const start = side === "new" ? hunk.additionStart : hunk.deletionStart;
    const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
    return Array.from({ length: count }, (_, offset) => start + offset);
  });
}

/** Hash a fixed hunk-local neighborhood for reload rematching. */
export function reviewLineContextDigest(file: ReviewFileV1, side: ReviewSide, line: number) {
  const address = reviewLineAddress(file, side, line);
  if (!address) return undefined;
  const hunk = file.hunks[address.hunkIndex]!;
  const lines = side === "new" ? file.additionLines : file.deletionLines;
  const lineIndex = side === "new" ? hunk.additionLineIndex : hunk.deletionLineIndex;
  const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
  const offset = file.flags.partial ? address.arrayIndex - lineIndex : address.arrayIndex;
  const availableStart = file.flags.partial ? lineIndex : 0;
  const availableCount = file.flags.partial ? count : lines.length;
  const neighborhood = [-2, -1, 0, 1, 2].map((delta) => {
    const candidate = offset + delta;
    return candidate >= 0 && candidate < availableCount ? lines[availableStart + candidate] : null;
  });
  return reviewDigest(JSON.stringify(neighborhood));
}

/** Find a uniquely nearest semantic line carrying the same context digest. */
function rematchLine(
  file: ReviewFileV1,
  side: ReviewSide,
  line: number,
  contextDigest: string | undefined,
) {
  if (!contextDigest) return reviewLineAddress(file, side, line) ? line : undefined;
  if (reviewLineContextDigest(file, side, line) === contextDigest) return line;
  const matches = reviewSemanticLines(file, side)
    .filter((candidate) => reviewLineContextDigest(file, side, candidate) === contextDigest)
    .map((candidate) => ({ line: candidate, distance: Math.abs(candidate - line) }))
    .toSorted((left, right) => left.distance - right.distance || left.line - right.line);
  if (matches.length === 0 || matches[0]!.distance === matches[1]?.distance) return undefined;
  return matches[0]!.line;
}

/** Match one logical file without depending on stream order or mutable runtime ids. */
export function reconcileReviewFile(
  previous: ReviewFileV1 | undefined,
  previousDocumentIdentity: string,
  document: ReviewDocumentV1,
  context?: { side: ReviewSide; line: number; digest?: string },
) {
  if (!previous) return undefined;
  const exact = document.files.find((file) => file.key === previous.key);
  if (exact) return exact;

  // Path and rename endpoints are meaningful only within the same reviewed source.
  if (previousDocumentIdentity !== document.documentIdentity) return undefined;
  const endpoints = new Set([previous.path, previous.previousPath].filter(Boolean));
  const candidates = document.files.filter(
    (file) =>
      endpoints.has(file.path) || (file.previousPath ? endpoints.has(file.previousPath) : false),
  );
  if (candidates.length <= 1) return candidates[0];
  if (context?.digest) {
    const rematched = candidates.flatMap((file) => {
      const line = rematchLine(file, context.side, context.line, context.digest);
      return line === undefined ? [] : [{ file, distance: Math.abs(line - context.line) }];
    });
    rematched.sort((left, right) => left.distance - right.distance);
    if (rematched.length > 0) {
      const nearest = rematched.filter(
        (candidate) => candidate.distance === rematched[0]!.distance,
      );
      if (nearest.length === 1) return nearest[0]!.file;
      const exactNearest = nearest.filter(({ file }) => file.path === previous.path);
      return exactNearest.length === 1 ? exactNearest[0]!.file : undefined;
    }
  }
  const exactPath = candidates.filter((file) => file.path === previous.path);
  return exactPath.length === 1 ? exactPath[0] : undefined;
}

/** Resolve a hunk index from a semantic line address. */
function hunkIndexForLine(file: ReviewFileV1, side: ReviewSide, line: number) {
  return reviewLineAddress(file, side, line)?.hunkIndex ?? -1;
}

/** Reconcile selection by file identity and line context, then fall back deterministically. */
export function reconcileReviewSelection(
  state: ReviewState,
  document: ReviewDocumentV1,
): ReviewSemanticSelection {
  const previousFile = state.document.files.find((file) => file.key === state.selection.fileKey);
  const side = state.selection.side;
  const line = state.selection.line;
  const matched = reconcileReviewFile(
    previousFile,
    state.document.documentIdentity,
    document,
    side && line !== undefined ? { side, line, digest: state.selection.contextDigest } : undefined,
  );

  if (matched && reviewFileMatchesFilter(matched, state.filter)) {
    const rematchedLine =
      side && line !== undefined
        ? rematchLine(matched, side, line, state.selection.contextDigest)
        : undefined;
    const semanticHunk =
      side && rematchedLine !== undefined ? hunkIndexForLine(matched, side, rematchedLine) : -1;
    return {
      fileKey: matched.key,
      hunkIndex:
        semanticHunk >= 0
          ? semanticHunk
          : Math.min(state.selection.hunkIndex, Math.max(0, matched.hunks.length - 1)),
      ...(side && rematchedLine !== undefined
        ? {
            side,
            line: rematchedLine,
            contextDigest: reviewLineContextDigest(matched, side, rematchedLine),
          }
        : {}),
    };
  }

  const fallback = document.files.find((file) => reviewFileMatchesFilter(file, state.filter));
  return { fileKey: fallback?.key ?? null, hunkIndex: 0 };
}

/** Recreate an original source-scoped address before its file can disappear. */
function storedNoteAddress(
  entry: ReviewStoredNote,
  previousDocument: ReviewDocumentV1,
): ReviewStoredNoteAddress | undefined {
  if (entry.originalAddress) return entry.originalAddress;
  const file = previousDocument.files.find((candidate) => candidate.key === entry.note.fileKey);
  if (!file) return undefined;
  return {
    documentIdentity: previousDocument.documentIdentity,
    fileKey: file.key,
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
  };
}

/** Rematch one declared side independently from evidence captured on that side. */
function rematchDeclaredRange(
  range: ReviewLineRange | undefined,
  side: ReviewSide,
  previousFile: ReviewFileV1 | undefined,
  matchedFile: ReviewFileV1,
  storedDigest: string | undefined,
) {
  if (!range) return { range: undefined, digest: undefined, verified: true };
  const digest =
    storedDigest ??
    (previousFile ? reviewLineContextDigest(previousFile, side, range[0]) : undefined);
  if (!digest) return { range, digest: undefined, verified: false };
  const line = rematchLine(matchedFile, side, range[0], digest);
  if (line === undefined) return { range, digest, verified: false };
  const rematchedRange = [line, line + (range[1] - range[0])] as const;
  return {
    range: rematchedRange,
    digest: reviewLineContextDigest(matchedFile, side, line),
    verified: true,
  };
}

/** Recompute all hunk memberships and ownership from independently rematched ranges. */
function rematchedAnchor(
  file: ReviewFileV1,
  preferred: { side: ReviewSide; line: number } | undefined,
  oldRange: ReviewLineRange | undefined,
  newRange: ReviewLineRange | undefined,
): ReviewRangeAnchorV1 {
  const intersectingHunkIndices = file.hunks.flatMap((hunk, index) => {
    const oldHunkRange = reviewHunkRange(hunk, "old");
    const newHunkRange = reviewHunkRange(hunk, "new");
    const intersects =
      Boolean(oldRange && oldRange[0] <= oldHunkRange[1] && oldHunkRange[0] <= oldRange[1]) ||
      Boolean(newRange && newRange[0] <= newHunkRange[1] && newHunkRange[0] <= newRange[1]);
    return intersects ? [index] : [];
  });
  const preferredOwner = preferred
    ? hunkIndexForLine(file, preferred.side, preferred.line)
    : undefined;
  const ownerHunkIndex =
    preferredOwner !== undefined && preferredOwner >= 0
      ? preferredOwner
      : (intersectingHunkIndices[0] ?? (file.hunks.length > 0 ? 0 : undefined));
  return {
    ...(oldRange ? { oldRange } : {}),
    ...(newRange ? { newRange } : {}),
    ...(preferred ? { preferred } : {}),
    intersectingHunkIndices,
    ...(ownerHunkIndex !== undefined ? { ownerHunkIndex } : {}),
  };
}

/** Reconcile one mutable note while retaining unresolved notes explicitly. */
function reconcileStoredNote(
  entry: ReviewStoredNote,
  previousDocument: ReviewDocumentV1,
  document: ReviewDocumentV1,
): ReviewStoredNote {
  const originalAddress = storedNoteAddress(entry, previousDocument);
  const currentFile = previousDocument.files.find((file) => file.key === entry.note.fileKey);
  const addressFile =
    currentFile ??
    (originalAddress
      ? ({
          key: originalAddress.fileKey,
          path: originalAddress.path,
          previousPath: originalAddress.previousPath,
        } as ReviewFileV1)
      : undefined);
  const preferred = entry.note.anchor.preferred;
  const retainedContextDigests = {
    ...(entry.contextDigests?.old
      ? { old: entry.contextDigests.old }
      : currentFile && entry.note.anchor.oldRange
        ? {
            old: reviewLineContextDigest(currentFile, "old", entry.note.anchor.oldRange[0]),
          }
        : {}),
    ...(entry.contextDigests?.new
      ? { new: entry.contextDigests.new }
      : currentFile && entry.note.anchor.newRange
        ? {
            new: reviewLineContextDigest(currentFile, "new", entry.note.anchor.newRange[0]),
          }
        : {}),
  };
  const matched = reconcileReviewFile(
    addressFile,
    originalAddress?.documentIdentity ?? previousDocument.documentIdentity,
    document,
    preferred
      ? { side: preferred.side, line: preferred.line, digest: entry.contextDigest }
      : undefined,
  );
  if (!matched)
    return {
      ...entry,
      ...(originalAddress ? { originalAddress } : {}),
      contextDigests: retainedContextDigests,
      resolution: "orphaned",
    };

  const oldResult = rematchDeclaredRange(
    entry.note.anchor.oldRange,
    "old",
    currentFile,
    matched,
    retainedContextDigests.old,
  );
  const newResult = rematchDeclaredRange(
    entry.note.anchor.newRange,
    "new",
    currentFile,
    matched,
    retainedContextDigests.new,
  );
  const preferredRangeBefore =
    preferred?.side === "old" ? entry.note.anchor.oldRange : entry.note.anchor.newRange;
  const preferredRangeAfter = preferred?.side === "old" ? oldResult.range : newResult.range;
  const preferredDigest =
    entry.contextDigest ??
    (preferred && currentFile
      ? reviewLineContextDigest(currentFile, preferred.side, preferred.line)
      : undefined);
  const independentlyRematchedPreferred = preferred
    ? rematchLine(matched, preferred.side, preferred.line, preferredDigest)
    : undefined;
  const rangeDelta =
    preferredRangeBefore && preferredRangeAfter
      ? preferredRangeAfter[0] - preferredRangeBefore[0]
      : undefined;
  const preferredLine = preferred
    ? (independentlyRematchedPreferred ??
      (rangeDelta !== undefined ? preferred.line + rangeDelta : undefined))
    : undefined;
  const nextPreferred =
    preferred && preferredLine !== undefined
      ? { side: preferred.side, line: preferredLine }
      : undefined;
  const anchor = rematchedAnchor(matched, nextPreferred, oldResult.range, newResult.range);
  const verified =
    oldResult.verified &&
    newResult.verified &&
    (!preferred || independentlyRematchedPreferred !== undefined || rangeDelta !== undefined);
  if (!verified || (nextPreferred && anchor.ownerHunkIndex === undefined)) {
    return {
      ...entry,
      ...(originalAddress ? { originalAddress } : {}),
      contextDigest: nextPreferred
        ? reviewLineContextDigest(matched, nextPreferred.side, nextPreferred.line)
        : entry.contextDigest,
      contextDigests: {
        ...(oldResult.digest ? { old: oldResult.digest } : {}),
        ...(newResult.digest ? { new: newResult.digest } : {}),
      },
      note: { ...entry.note, fileKey: matched.key, anchor },
      resolution: "stale",
    };
  }

  return {
    ...entry,
    ...(originalAddress ? { originalAddress } : {}),
    resolution: "active",
    contextDigest: nextPreferred
      ? reviewLineContextDigest(matched, nextPreferred.side, nextPreferred.line)
      : entry.contextDigest,
    contextDigests: {
      ...(oldResult.digest ? { old: oldResult.digest } : {}),
      ...(newResult.digest ? { new: newResult.digest } : {}),
    },
    note: { ...entry.note, fileKey: matched.key, anchor },
  };
}

/** Preserve only expansions whose file, source identity, and gap address remain valid. */
function reconcileExpandedGap(
  gap: ReviewExpandedGapState,
  previousDocument: ReviewDocumentV1,
  document: ReviewDocumentV1,
) {
  const previousFile = previousDocument.files.find((file) => file.key === gap.fileKey);
  const file = reconcileReviewFile(previousFile, previousDocument.documentIdentity, document);
  if (!file) return undefined;
  const sourceId = file.sourceResourceIds[gap.side];
  const source = document.resources.find((resource) => resource.id === sourceId);
  const previousAddress = previousFile ? reviewGapAddress(previousFile, gap.gapId) : undefined;
  const address = reviewGapAddress(file, gap.gapId);
  const validGap = Boolean(
    previousAddress &&
    previousAddress.oldRange[0] === gap.oldRange[0] &&
    previousAddress.oldRange[1] === gap.oldRange[1] &&
    previousAddress.newRange[0] === gap.newRange[0] &&
    previousAddress.newRange[1] === gap.newRange[1] &&
    address &&
    address.oldRange[0] === gap.oldRange[0] &&
    address.oldRange[1] === gap.oldRange[1] &&
    address.newRange[0] === gap.newRange[0] &&
    address.newRange[1] === gap.newRange[1],
  );
  if (
    !source ||
    source.kind !== "source" ||
    source.sourceIdentity !== gap.sourceIdentity ||
    !validGap
  )
    return undefined;
  return { ...gap, fileKey: file.key };
}

/** Read materialized source evidence for one gap generation. */
function materializedGapSourceDigest(document: ReviewDocumentV1, gap: ReviewExpandedGapState) {
  const file = document.files.find((candidate) => candidate.key === gap.fileKey);
  const resourceId = file?.sourceResourceIds[gap.side];
  const resource = document.resources.find((candidate) => candidate.id === resourceId);
  return resource?.kind === "source" ? resource.digest : undefined;
}

/** Disambiguate retained mutable ids against the replacement document and each other. */
function reconcileMutableNoteIds(
  document: ReviewDocumentV1,
  liveNotes: ReviewStoredNote[],
  userNotes: ReviewStoredNote[],
) {
  const usedIds = new Set(document.files.flatMap((file) => file.notes.map((note) => note.id)));
  const disambiguate = (entry: ReviewStoredNote) => {
    const baseId = entry.note.id;
    let id = baseId;
    let suffix = 1;
    while (usedIds.has(id)) {
      id = `${baseId}:${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    return id === baseId ? entry : { ...entry, note: { ...entry.note, id } };
  };
  return {
    liveNotes: liveNotes.map(disambiguate),
    userNotes: userNotes.map(disambiguate),
  };
}

/** Compare immutable generation identities for constant-time reconcile no-op detection. */
export function reviewDocumentsEqual(left: ReviewDocumentV1, right: ReviewDocumentV1) {
  return left === right || left.generation === right.generation;
}

/** Preserve a draft only when its semantic source address rematches confidently. */
function reconcileDraftNote(
  draft: ReviewDraftNote | null,
  previousDocument: ReviewDocumentV1,
  document: ReviewDocumentV1,
) {
  if (!draft) return null;
  const previousFile = previousDocument.files.find((file) => file.key === draft.fileKey);
  if (!previousFile) return null;
  const digest = reviewLineContextDigest(previousFile, draft.side, draft.line);
  const matched = reconcileReviewFile(previousFile, previousDocument.documentIdentity, document, {
    side: draft.side,
    line: draft.line,
    digest,
  });
  if (!matched) return null;
  const line = rematchLine(matched, draft.side, draft.line, digest);
  if (line === undefined) return null;
  const hunkIndex = hunkIndexForLine(matched, draft.side, line);
  if (hunkIndex < 0) return null;
  const oldResult = rematchDeclaredRange(draft.oldRange, "old", previousFile, matched, undefined);
  const newResult = rematchDeclaredRange(draft.newRange, "new", previousFile, matched, undefined);
  if (!oldResult.verified || !newResult.verified) return null;
  const oldRange = oldResult.range;
  const newRange = newResult.range;
  return {
    ...draft,
    fileKey: matched.key,
    hunkIndex,
    line,
    ...(oldRange ? { oldRange: [...oldRange] as [number, number] } : {}),
    ...(newRange ? { newRange: [...newRange] as [number, number] } : {}),
  };
}

/** Atomically replace a document and reconcile all shared semantic state. */
export function reconcileReviewState(state: ReviewState, document: ReviewDocumentV1): ReviewState {
  const expandedGaps = state.expandedGaps.flatMap((gap) => {
    const reconciled = reconcileExpandedGap(gap, state.document, document);
    return reconciled ? [reconciled] : [];
  });
  const reconciledSourceStatus: ReviewState["sourceStatusByFileKey"] = {};
  for (const previousGap of state.expandedGaps) {
    const nextGap = expandedGaps.find(
      (candidate) =>
        candidate.gapId === previousGap.gapId &&
        candidate.side === previousGap.side &&
        candidate.sourceIdentity === previousGap.sourceIdentity,
    );
    const status = state.sourceStatusByFileKey[previousGap.fileKey];
    const previousDigest = materializedGapSourceDigest(state.document, previousGap);
    const nextDigest = nextGap ? materializedGapSourceDigest(document, nextGap) : undefined;
    if (
      nextGap &&
      status?.kind === "loaded" &&
      previousDigest &&
      previousDigest === nextDigest &&
      reviewDigest(status.text) === previousDigest
    ) {
      reconciledSourceStatus[nextGap.fileKey] = status;
    }
  }
  const notes = reconcileMutableNoteIds(
    document,
    state.liveNotes.map((note) => reconcileStoredNote(note, state.document, document)),
    state.userNotes.map((note) => reconcileStoredNote(note, state.document, document)),
  );
  return {
    ...state,
    document,
    documentGeneration: document.generation,
    documentRevision: state.documentRevision + 1,
    selection: reconcileReviewSelection(state, document),
    liveNotes: notes.liveNotes,
    userNotes: notes.userNotes,
    draftNote: reconcileDraftNote(state.draftNote, state.document, document),
    expandedGaps,
    sourceStatusByFileKey: reconciledSourceStatus,
  };
}
