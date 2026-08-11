import type { ReviewAction } from "./actions";
import { resolveReviewLineAddress, resolveReviewNoteAnchor } from "./anchors";
import type { ReviewSemanticSelection, ReviewState, ReviewStoredNote } from "./state";
import type { ReviewFileV1, ReviewSide } from "./types";

export interface ReviewIntentFacts {
  /** Runtime-allocated base identity for a newly persisted user note. */
  noteId?: string;
  /** Runtime-owned ISO timestamp for note creation or update. */
  timestamp?: string;
}

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
      line?: { side: ReviewSide; line: number };
      reveal?: ReviewRevealRequest;
    }
  | {
      type: "selection/set-line";
      fileKey: string;
      hunkIndex: number;
      side: ReviewSide;
      line: number;
      reveal?: boolean;
    }
  | { type: "filter/set"; filter: string }
  | { type: "notes/set-visibility"; visible: boolean };

export type ReviewIntentOutcome =
  | { type: "note/created"; note: ReviewStoredNote }
  | { type: "note/updated"; note: ReviewStoredNote }
  | { type: "note/removed"; noteId: string; source: "user" | "live" };

export interface ReviewIntentPlan {
  actions: readonly ReviewAction[];
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
function requireFact(value: string | undefined, label: "noteId" | "timestamp") {
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

/** Resolve a backed semantic line and distinguish an invalid hunk claim. */
function requireLine(
  file: ReviewFileV1,
  target: { side: ReviewSide; line: number; hunkIndex: number },
) {
  const address = resolveReviewLineAddress(file, {
    side: target.side,
    line: target.line,
  });
  if (!address) {
    throw new ReviewIntentPlanningError(
      "line-not-backed",
      `Review line ${target.side}:${target.line} is not backed by canonical diff content.`,
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
  },
  facts: ReviewIntentFacts,
) {
  const file = requireFile(state, target.fileKey);
  requireHunk(file, target.hunkIndex);
  const address = requireLine(file, target);
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
      anchor: resolveReviewNoteAnchor(file, { oldRange, newRange, preferred }),
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
  requireHunk(file, intent.hunkIndex);
  const address = intent.line
    ? requireLine(file, { ...intent.line, hunkIndex: intent.hunkIndex })
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
  const address = requireLine(file, intent);
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
  }
}
