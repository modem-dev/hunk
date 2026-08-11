import type { ReviewAction } from "./actions";
import {
  resolveReviewLineAddress,
  resolveReviewNoteAnchor,
  reviewSourceLineContextDigest,
} from "./anchors";
import { reviewGapAddress } from "./expansion";
import { reviewDigest } from "./identity";
import type {
  ReviewExpandedLineProof,
  ReviewSemanticSelection,
  ReviewState,
  ReviewStoredNote,
} from "./state";
import type { ReviewFileV1, ReviewSide } from "./types";

export interface ReviewIntentFacts {
  /** Runtime-allocated base identity for a newly persisted user note. */
  noteId?: string;
  /** Runtime-owned ISO timestamp for note creation or update. */
  timestamp?: string;
  /** Opaque runtime identity for the exact source fetcher backing an expansion. */
  sourceFetcherIdentity?: string;
}

export interface ReviewSourceLoadEffect {
  type: "source/load";
  generation: string;
  fileKey: string;
  side: ReviewSide;
  gapId: string;
  oldRange: readonly [number, number];
  newRange: readonly [number, number];
  sourceIdentity: string;
  resourceId: string;
  sourceFetcherIdentity: string;
}

export type ReviewIntentEffect = ReviewSourceLoadEffect;

export interface ReviewRevealRequest {
  kind: "hunk" | "file-top" | "line";
  scrollToNote?: boolean;
}

interface ExplicitUserNoteIntent {
  type: "note/create-user";
  consumeDraft?: false;
  fileKey: string;
  hunkIndex: number;
  side: ReviewSide;
  line: number;
  body: string;
  markup?: string;
  expandedLineProof?: ReviewExpandedLineProof;
}

interface DraftUserNoteIntent {
  type: "note/create-user";
  consumeDraft: true;
}

export type ReviewIntent =
  | ExplicitUserNoteIntent
  | DraftUserNoteIntent
  | { type: "note/update-user"; noteId: string; body: string; markup?: string }
  | { type: "note/remove-user"; noteId: string }
  | { type: "note/remove-live"; noteId: string }
  | {
      type: "selection/select";
      fileKey: string;
      hunkIndex: number;
      line?: { side: ReviewSide; line: number; expandedLineProof?: ReviewExpandedLineProof };
      reveal?: ReviewRevealRequest;
    }
  | {
      type: "selection/set-line";
      fileKey: string;
      hunkIndex: number;
      side: ReviewSide;
      line: number;
      expandedLineProof?: ReviewExpandedLineProof;
      reveal?: boolean;
    }
  | { type: "filter/set"; filter: string }
  | { type: "notes/set-visibility"; visible: boolean }
  | { type: "expansion/toggle"; fileKey: string; gapId: string };

export type ReviewIntentOutcome =
  | { type: "note/created"; note: ReviewStoredNote }
  | { type: "note/updated"; note: ReviewStoredNote }
  | { type: "note/removed"; noteId: string; source: "user" | "live" };

export interface ReviewIntentPlan {
  actions: readonly ReviewAction[];
  /** Runtime-owned work started only after the complete action batch commits. */
  effects?: readonly ReviewIntentEffect[];
  /** Concrete note operation result; state/no-op status comes from transactional execution. */
  outcome?: ReviewIntentOutcome;
}

export type ReviewIntentPlanningErrorCode =
  | "file-not-found"
  | "hunk-not-found"
  | "line-not-backed"
  | "line-hunk-mismatch"
  | "empty-note-body"
  | "draft-missing"
  | "note-not-found"
  | "note-not-editable"
  | "gap-not-found"
  | "source-unavailable"
  | "missing-fact";

/** Typed semantic rejection raised before any review state is reduced or published. */
export class ReviewIntentPlanningError extends Error {
  override readonly name = "ReviewIntentPlanningError";

  constructor(
    readonly code: ReviewIntentPlanningErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Preserve the live-note mutability policy exposed by existing browser actions. */
export function isLiveReviewNoteRemovable(entry: ReviewStoredNote) {
  return entry.note.origin === "live-agent" || entry.note.editable !== false;
}

/** Return every note identity reserved inside one authoritative review state. */
function reservedNoteIds(state: ReviewState) {
  return new Set([
    ...state.document.files.flatMap((file) => file.notes.map((note) => note.id)),
    ...state.liveNotes.map((entry) => entry.note.id),
    ...state.userNotes.map((entry) => entry.note.id),
  ]);
}

/** Reserve a deterministic note identity while reducer allocation remains defense-in-depth. */
function reserveNoteId(state: ReviewState, baseId: string) {
  const used = reservedNoteIds(state);
  let id = baseId;
  let suffix = 1;
  while (used.has(id)) {
    id = `${baseId}:${suffix}`;
    suffix += 1;
  }
  return id;
}

/** Require one runtime-owned fact without letting core allocate time or identity. */
function requireFact(
  value: string | undefined,
  label: "noteId" | "timestamp" | "sourceFetcherIdentity",
) {
  if (!value) {
    throw new ReviewIntentPlanningError("missing-fact", `Review intent requires ${label}.`);
  }
  return value;
}

/** Resolve one current semantic file or reject the explicit target. */
function requireFile(state: ReviewState, fileKey: string) {
  const file = state.document.files.find((candidate) => candidate.key === fileKey);
  if (!file) {
    throw new ReviewIntentPlanningError(
      "file-not-found",
      `Review file ${fileKey} does not exist in the current generation.`,
    );
  }
  return file;
}

/** Require one exact hunk instead of relying on reducer clamping. */
function requireHunk(file: ReviewFileV1, hunkIndex: number) {
  if (!Number.isSafeInteger(hunkIndex) || hunkIndex < 0 || !file.hunks[hunkIndex]) {
    throw new ReviewIntentPlanningError(
      "hunk-not-found",
      `Review hunk ${hunkIndex} does not exist in ${file.path}.`,
    );
  }
}

/** Compare one persisted inclusive range without accepting stale geometry. */
function reviewRangesEqual(left: readonly [number, number], right: readonly [number, number]) {
  return left[0] === right[0] && left[1] === right[1];
}

/** Resolve one process-local expanded-source proof against current semantic authority. */
function resolveExpandedReviewLine(
  state: ReviewState,
  file: ReviewFileV1,
  target: {
    side: ReviewSide;
    line: number;
    hunkIndex: number;
    expandedLineProof: ReviewExpandedLineProof;
  },
) {
  const gap = state.expandedGaps.find(
    (candidate) =>
      candidate.fileKey === file.key &&
      candidate.gapId === target.expandedLineProof.gapId &&
      candidate.sourceIdentity === target.expandedLineProof.sourceIdentity,
  );
  const gapMatch = /^(?:before|trailing):(\d+)$/.exec(target.expandedLineProof.gapId);
  if (!gap || !gap.expanded || !gapMatch) return undefined;
  if (Number(gapMatch[1]) !== target.hunkIndex) {
    throw new ReviewIntentPlanningError(
      "line-hunk-mismatch",
      `Expanded review line belongs to hunk ${gapMatch[1]}, not ${target.hunkIndex}.`,
    );
  }
  if (gap.side !== target.side) return undefined;
  const address = reviewGapAddress(file, gap.gapId);
  if (
    !address ||
    !reviewRangesEqual(gap.oldRange, address.oldRange) ||
    !reviewRangesEqual(gap.newRange, address.newRange)
  ) {
    return undefined;
  }
  const range = target.side === "new" ? address.newRange : address.oldRange;
  if (target.line < range[0] || target.line > range[1]) return undefined;
  const resourceId = file.sourceResourceIds[target.side];
  const descriptor = state.document.resources.find(
    (resource) =>
      resource.id === resourceId &&
      resource.kind === "source" &&
      resource.fileKey === file.key &&
      resource.side === target.side &&
      resource.sourceIdentity === gap.sourceIdentity,
  );
  if (!descriptor || descriptor.byteLength === undefined || descriptor.digest === undefined) {
    return undefined;
  }
  const sourceStatus = state.sourceStatusByFileKey[file.key];
  if (sourceStatus?.kind !== "loaded") return undefined;
  if (
    Buffer.byteLength(sourceStatus.text, "utf8") !== descriptor.byteLength ||
    reviewDigest(sourceStatus.text) !== descriptor.digest
  ) {
    return undefined;
  }
  const contextDigest = reviewSourceLineContextDigest(sourceStatus.text, target.line);
  if (!contextDigest) return undefined;
  return {
    side: target.side,
    line: target.line,
    hunkIndex: target.hunkIndex,
    arrayIndex: target.line - 1,
    contextDigest,
  };
}

/** Resolve a backed semantic line and distinguish an invalid hunk claim. */
function requireLine(
  state: ReviewState,
  file: ReviewFileV1,
  target: {
    side: ReviewSide;
    line: number;
    hunkIndex: number;
    expandedLineProof?: ReviewExpandedLineProof;
  },
) {
  const address = target.expandedLineProof
    ? resolveExpandedReviewLine(state, file, {
        ...target,
        expandedLineProof: target.expandedLineProof,
      })
    : resolveReviewLineAddress(file, {
        side: target.side,
        line: target.line,
      });
  if (!address) {
    throw new ReviewIntentPlanningError(
      "line-not-backed",
      `Review line ${target.side}:${target.line} is not backed by current canonical or expanded source content.`,
    );
  }
  if (address.hunkIndex !== target.hunkIndex) {
    throw new ReviewIntentPlanningError(
      "line-hunk-mismatch",
      `Review line ${target.side}:${target.line} belongs to hunk ${address.hunkIndex}, not ${target.hunkIndex}.`,
    );
  }
  return address;
}

/** Construct one canonical persisted user note from a strict semantic line target. */
function createStoredUserNote(
  state: ReviewState,
  target: {
    fileKey: string;
    hunkIndex: number;
    side: ReviewSide;
    line: number;
    body: string;
    markup?: string;
    expandedLineProof?: ReviewExpandedLineProof;
  },
  facts: ReviewIntentFacts,
) {
  const file = requireFile(state, target.fileKey);
  requireHunk(file, target.hunkIndex);
  const address = requireLine(state, file, target);
  const summary = target.body.trim();
  if (!summary) {
    throw new ReviewIntentPlanningError("empty-note-body", "A user note body is required.");
  }
  const range = [address.line, address.line] as const;
  const oldRange = address.side === "old" ? range : undefined;
  const newRange = address.side === "new" ? range : undefined;
  const preferred = { side: address.side, line: address.line };
  const noteId = reserveNoteId(state, requireFact(facts.noteId, "noteId"));
  const createdAt = requireFact(facts.timestamp, "timestamp");
  const markup = target.markup?.trim() ? target.markup : undefined;
  return {
    note: {
      id: noteId,
      source: "user" as const,
      origin: "user" as const,
      originalSource: "user",
      fileKey: file.key,
      anchor: resolveReviewNoteAnchor(file, {
        oldRange,
        newRange,
        preferred,
        ...(target.expandedLineProof ? { fallbackOwnerHunkIndex: target.hunkIndex } : {}),
      }),
      summary,
      ...(markup !== undefined ? { markup } : {}),
      author: "user",
      createdAt,
      editable: true,
    },
    contextDigest: address.contextDigest,
    contextDigests: { [address.side]: address.contextDigest },
    resolution: "active" as const,
  } satisfies ReviewStoredNote;
}

/** Plan one user-note creation, optionally consuming the terminal's current draft atomically. */
function planUserNoteCreation(
  state: ReviewState,
  intent: ExplicitUserNoteIntent | DraftUserNoteIntent,
  facts: ReviewIntentFacts,
): ReviewIntentPlan {
  const target = intent.consumeDraft
    ? (() => {
        const draft = state.draftNote;
        if (!draft) {
          throw new ReviewIntentPlanningError("draft-missing", "No user note draft is active.");
        }
        return {
          fileKey: draft.fileKey,
          hunkIndex: draft.hunkIndex,
          side: draft.side,
          line: draft.line,
          body: draft.body,
          ...(draft.expandedLineProof ? { expandedLineProof: draft.expandedLineProof } : {}),
        };
      })()
    : intent;
  const note = createStoredUserNote(state, target, facts);
  return {
    actions: [
      intent.consumeDraft
        ? {
            type: "draft/save",
            expectedGeneration: state.documentGeneration,
            note,
          }
        : {
            type: "notes/add-user",
            expectedGeneration: state.documentGeneration,
            note,
          },
    ],
    outcome: { type: "note/created", note },
  };
}

/** Plan replacement of editable user content while retaining its semantic address. */
function planUserNoteUpdate(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "note/update-user" }>,
  facts: ReviewIntentFacts,
): ReviewIntentPlan {
  const existing = state.userNotes.find((entry) => entry.note.id === intent.noteId);
  if (!existing) {
    throw new ReviewIntentPlanningError(
      "note-not-found",
      `No user note matches id ${intent.noteId}.`,
    );
  }
  if (!existing.note.editable) {
    throw new ReviewIntentPlanningError(
      "note-not-editable",
      `User note ${intent.noteId} is not editable.`,
    );
  }
  const summary = intent.body.trim();
  if (!summary) {
    throw new ReviewIntentPlanningError("empty-note-body", "A user note body is required.");
  }
  const timestamp = requireFact(facts.timestamp, "timestamp");
  const { markup: existingMarkup, ...withoutMarkup } = existing.note;
  const note: ReviewStoredNote = {
    ...existing,
    note: {
      ...withoutMarkup,
      summary,
      ...(intent.markup === undefined
        ? existingMarkup === undefined
          ? {}
          : { markup: existingMarkup }
        : intent.markup.trim()
          ? { markup: intent.markup }
          : {}),
      updatedAt: timestamp,
    },
  };
  return {
    actions: [
      {
        type: "notes/update-user",
        expectedGeneration: state.documentGeneration,
        noteId: intent.noteId,
        note,
      },
    ],
    outcome: { type: "note/updated", note },
  };
}

/** Plan removal from the authoritative editable user-note collection. */
function planUserNoteRemoval(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "note/remove-user" }>,
): ReviewIntentPlan {
  const existing = state.userNotes.find((entry) => entry.note.id === intent.noteId);
  if (!existing) {
    throw new ReviewIntentPlanningError(
      "note-not-found",
      `No user note matches id ${intent.noteId}.`,
    );
  }
  if (!existing.note.editable) {
    throw new ReviewIntentPlanningError(
      "note-not-editable",
      `User note ${intent.noteId} is not editable.`,
    );
  }
  return {
    actions: [
      {
        type: "notes/remove-user",
        expectedGeneration: state.documentGeneration,
        noteId: intent.noteId,
      },
    ],
    outcome: { type: "note/removed", noteId: intent.noteId, source: "user" },
  };
}

/** Plan removal through the named compatibility policy for live notes. */
function planLiveNoteRemoval(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "note/remove-live" }>,
): ReviewIntentPlan {
  const existing = state.liveNotes.find((entry) => entry.note.id === intent.noteId);
  if (!existing) {
    throw new ReviewIntentPlanningError(
      "note-not-found",
      `No live note matches id ${intent.noteId}.`,
    );
  }
  if (!isLiveReviewNoteRemovable(existing)) {
    throw new ReviewIntentPlanningError(
      "note-not-editable",
      `Live note ${intent.noteId} cannot be removed.`,
    );
  }
  return {
    actions: [
      {
        type: "notes/remove-live",
        expectedGeneration: state.documentGeneration,
        noteId: intent.noteId,
      },
    ],
    outcome: { type: "note/removed", noteId: intent.noteId, source: "live" },
  };
}

/** Plan one strict absolute hunk selection and optional backed line address. */
function planHunkSelection(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "selection/select" }>,
): ReviewIntentPlan {
  const file = requireFile(state, intent.fileKey);
  // Hunkless files remain valid file-level selections at the reducer's canonical index zero.
  if (file.hunks.length > 0 || intent.hunkIndex !== 0 || intent.line) {
    requireHunk(file, intent.hunkIndex);
  }
  const address = intent.line
    ? requireLine(state, file, { ...intent.line, hunkIndex: intent.hunkIndex })
    : undefined;
  const selection: ReviewSemanticSelection = {
    fileKey: file.key,
    hunkIndex: intent.hunkIndex,
    ...(address
      ? {
          side: address.side,
          line: address.line,
          contextDigest: address.contextDigest,
        }
      : {}),
  };
  return {
    actions: [
      {
        type: "selection/select",
        selection,
        ...(intent.reveal ? { reveal: intent.reveal } : {}),
      },
    ],
  };
}

/** Plan one strict line selection with canonical hunk and context evidence. */
function planLineSelection(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "selection/set-line" }>,
): ReviewIntentPlan {
  const file = requireFile(state, intent.fileKey);
  requireHunk(file, intent.hunkIndex);
  const address = requireLine(state, file, intent);
  return {
    actions: [
      {
        type: "selection/set-line",
        fileKey: file.key,
        hunkIndex: address.hunkIndex,
        side: address.side,
        line: address.line,
        contextDigest: address.contextDigest,
        ...(intent.reveal === undefined ? {} : { reveal: intent.reveal }),
      },
    ],
  };
}

/** Resolve a canonical backed line in one hunk, preferring the expansion's source side. */
function canonicalLineForHunk(file: ReviewFileV1, hunkIndex: number, preferredSide: ReviewSide) {
  const hunk = file.hunks[hunkIndex];
  if (!hunk) return undefined;
  for (const side of [preferredSide, preferredSide === "new" ? "old" : "new"] as const) {
    const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
    const line = side === "new" ? hunk.additionStart : hunk.deletionStart;
    if (count <= 0) continue;
    const address = resolveReviewLineAddress(file, { side, line });
    if (address?.hunkIndex === hunkIndex) return address;
  }
  return undefined;
}

/** Plan a canonical gap toggle and any post-commit source materialization effect. */
function planExpansionToggle(
  state: ReviewState,
  intent: Extract<ReviewIntent, { type: "expansion/toggle" }>,
  facts: ReviewIntentFacts,
): ReviewIntentPlan {
  const file = requireFile(state, intent.fileKey);
  const address = reviewGapAddress(file, intent.gapId);
  const gapMatch = /^(?:before|trailing):(\d+)$/.exec(intent.gapId);
  if (!address || !gapMatch) {
    throw new ReviewIntentPlanningError(
      "gap-not-found",
      `The collapsed source gap ${intent.gapId} is invalid for ${file.path}.`,
    );
  }
  const hunkIndex = Number(gapMatch[1]);
  requireHunk(file, hunkIndex);
  const side: ReviewSide = file.changeKind === "deleted" ? "old" : "new";
  const resourceId = file.sourceResourceIds[side];
  const descriptor = state.document.resources.find(
    (resource) =>
      resource.id === resourceId &&
      resource.kind === "source" &&
      resource.generation === state.documentGeneration &&
      resource.fileKey === file.key &&
      resource.side === side,
  );
  if (!descriptor || descriptor.kind !== "source") {
    throw new ReviewIntentPlanningError(
      "source-unavailable",
      `Expanded ${side} source is unavailable for ${file.path}.`,
    );
  }
  const current = state.expandedGaps.find(
    (gap) => gap.fileKey === file.key && gap.gapId === intent.gapId,
  );
  const expanding = !current?.expanded;
  const gap = {
    fileKey: file.key,
    gapId: intent.gapId,
    side,
    oldRange: [...address.oldRange] as [number, number],
    newRange: [...address.newRange] as [number, number],
    sourceIdentity: descriptor.sourceIdentity,
    expanded: expanding,
  };
  const actions: ReviewAction[] = [
    { type: "expansion/toggle", expectedGeneration: state.documentGeneration, gap },
  ];

  if (!expanding) {
    const selection = state.selection;
    if (
      current?.expanded &&
      current.side === side &&
      current.sourceIdentity === descriptor.sourceIdentity &&
      reviewRangesEqual(current.oldRange, address.oldRange) &&
      reviewRangesEqual(current.newRange, address.newRange) &&
      selection.fileKey === file.key &&
      selection.hunkIndex === hunkIndex &&
      selection.side === side &&
      selection.line !== undefined
    ) {
      const proven = resolveExpandedReviewLine(state, file, {
        side,
        line: selection.line,
        hunkIndex,
        expandedLineProof: { gapId: intent.gapId, sourceIdentity: descriptor.sourceIdentity },
      });
      if (proven && proven.contextDigest === selection.contextDigest) {
        const replacement = canonicalLineForHunk(file, hunkIndex, side);
        if (replacement) {
          actions.push({
            type: "selection/set-line",
            fileKey: file.key,
            hunkIndex,
            side: replacement.side,
            line: replacement.line,
            contextDigest: replacement.contextDigest,
          });
        }
      }
    }
    return { actions };
  }

  const status = state.sourceStatusByFileKey[file.key];
  if (status?.kind === "loaded") {
    if (
      descriptor.byteLength === undefined ||
      descriptor.digest === undefined ||
      Buffer.byteLength(status.text, "utf8") !== descriptor.byteLength ||
      reviewDigest(status.text) !== descriptor.digest
    ) {
      throw new ReviewIntentPlanningError(
        "source-unavailable",
        `Expanded ${side} source authority is inconsistent for ${file.path}.`,
      );
    }
    return { actions };
  }
  if (status?.kind === "loading") return { actions };
  const sourceFetcherIdentity = requireFact(facts.sourceFetcherIdentity, "sourceFetcherIdentity");
  actions.push({
    type: "expansion/set-source-status",
    expectedGeneration: state.documentGeneration,
    fileKey: file.key,
    status: { kind: "loading" },
  });
  return {
    actions,
    effects: [
      {
        type: "source/load",
        generation: state.documentGeneration,
        fileKey: file.key,
        side,
        gapId: intent.gapId,
        oldRange: [...address.oldRange] as [number, number],
        newRange: [...address.newRange] as [number, number],
        sourceIdentity: descriptor.sourceIdentity,
        resourceId: descriptor.id,
        sourceFetcherIdentity,
      },
    ],
  };
}

/** Convert one renderer-neutral semantic intent into ordered internal reducer actions. */
export function planReviewIntent(
  state: ReviewState,
  intent: ReviewIntent,
  facts: ReviewIntentFacts = {},
): ReviewIntentPlan {
  switch (intent.type) {
    case "note/create-user":
      return planUserNoteCreation(state, intent, facts);
    case "note/update-user":
      return planUserNoteUpdate(state, intent, facts);
    case "note/remove-user":
      return planUserNoteRemoval(state, intent);
    case "note/remove-live":
      return planLiveNoteRemoval(state, intent);
    case "selection/select":
      return planHunkSelection(state, intent);
    case "selection/set-line":
      return planLineSelection(state, intent);
    case "filter/set":
      return {
        actions: [{ type: "filter/set", filter: intent.filter }],
      };
    case "notes/set-visibility":
      return {
        actions: [{ type: "notes/set-visibility", visible: intent.visible }],
      };
    case "expansion/toggle":
      return planExpansionToggle(state, intent, facts);
  }
}
