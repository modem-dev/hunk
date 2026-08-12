import type { ReviewAction } from "./actions";
import { reconcileReviewState, reviewDocumentsEqual } from "./reconcile";
import { reviewFileMatchesFilter } from "./selectors";
import type { ReviewSourceStatus, ReviewState } from "./state";

/** Compare renderer-neutral source statuses by semantic value. */
function sourceStatusesEqual(left: ReviewSourceStatus | undefined, right: ReviewSourceStatus) {
  if (!left || left.kind !== right.kind) return false;
  if (left.kind === "loaded" && right.kind === "loaded") return left.text === right.text;
  if (left.kind === "error" && right.kind === "error") return left.reason === right.reason;
  return true;
}

/** Enforce generation preconditions for mutable generation-addressed actions. */
function assertGeneration(state: ReviewState, action: { expectedGeneration: string }) {
  if (action.expectedGeneration !== state.documentGeneration) {
    throw new Error(
      `Stale review action for ${action.expectedGeneration}; current generation is ${state.documentGeneration}.`,
    );
  }
}

/** Allocate one globally unique note id with deterministic numeric suffixes. */
function allocateNoteId(baseId: string, usedIds: Set<string>) {
  let id = baseId;
  let suffix = 1;
  while (usedIds.has(id)) {
    id = `${baseId}:${suffix}`;
    suffix += 1;
  }
  usedIds.add(id);
  return id;
}

/** Return every id currently addressable in the live review. */
function liveNoteIds(state: ReviewState) {
  return new Set([
    ...state.document.files.flatMap((file) => file.notes.map((note) => note.id)),
    ...state.liveNotes.map((entry) => entry.note.id),
    ...state.userNotes.map((entry) => entry.note.id),
  ]);
}

/** Compare serialization-safe drafts by semantic value. */
function draftsEqual(left: ReviewState["draftNote"], right: ReviewState["draftNote"]) {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** Apply one named semantic action without renderer or React dependencies. */
export function reduceReviewState(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case "document/reconcile":
      assertGeneration(state, action);
      if (reviewDocumentsEqual(action.document, state.document)) return state;
      return reconcileReviewState(state, action.document);
    case "selection/select": {
      const file = state.document.files.find(
        (candidate) => candidate.key === action.selection.fileKey,
      );
      if (!file) return state;
      const hunkIndex = Math.min(
        Math.max(0, action.selection.hunkIndex),
        Math.max(0, file.hunks.length - 1),
      );
      const selection = { ...action.selection, fileKey: file.key, hunkIndex };
      const selectionChanged =
        selection.fileKey !== state.selection.fileKey ||
        selection.hunkIndex !== state.selection.hunkIndex ||
        selection.side !== state.selection.side ||
        selection.line !== state.selection.line ||
        selection.contextDigest !== state.selection.contextDigest;
      if (!selectionChanged && !action.reveal) return state;
      return {
        ...state,
        selection,
        ...(action.reveal
          ? {
              reveal: {
                ...state.reveal,
                token: state.reveal.token + 1,
                fileTopToken:
                  state.reveal.fileTopToken + (action.reveal.kind === "file-top" ? 1 : 0),
                hunkToken: state.reveal.hunkToken + (action.reveal.kind === "hunk" ? 1 : 0),
                lineToken: state.reveal.lineToken + (action.reveal.kind === "line" ? 1 : 0),
                kind: action.reveal.kind,
                scrollToNote: Boolean(action.reveal.scrollToNote),
              },
            }
          : {}),
      };
    }
    case "selection/set-line": {
      const file = state.document.files.find((candidate) => candidate.key === action.fileKey);
      if (!file) return state;
      const selection = {
        fileKey: file.key,
        hunkIndex: Math.min(Math.max(0, action.hunkIndex), Math.max(0, file.hunks.length - 1)),
        side: action.side,
        line: action.line,
        ...(action.contextDigest ? { contextDigest: action.contextDigest } : {}),
      };
      const unchanged =
        state.selection.fileKey === selection.fileKey &&
        state.selection.hunkIndex === selection.hunkIndex &&
        state.selection.side === selection.side &&
        state.selection.line === selection.line &&
        state.selection.contextDigest === selection.contextDigest &&
        !action.reveal;
      if (unchanged) return state;
      return {
        ...state,
        selection,
        ...(action.reveal
          ? {
              reveal: {
                ...state.reveal,
                token: state.reveal.token + 1,
                lineToken: state.reveal.lineToken + 1,
                kind: "line" as const,
                scrollToNote: false,
              },
            }
          : {}),
      };
    }
    case "filter/set": {
      if (action.filter === state.filter) return state;
      const selected = state.document.files.find((file) => file.key === state.selection.fileKey);
      const fallback = state.document.files.find((file) =>
        reviewFileMatchesFilter(file, action.filter),
      );
      return {
        ...state,
        filter: action.filter,
        ...(!selected || !reviewFileMatchesFilter(selected, action.filter)
          ? { selection: { fileKey: fallback?.key ?? null, hunkIndex: 0 } }
          : {}),
      };
    }
    case "notes/set-visibility":
      return action.visible === state.showAgentNotes
        ? state
        : { ...state, showAgentNotes: action.visible };
    case "trust/set-prompt":
      assertGeneration(state, action);
      return action.repoRoot === state.trustPromptRepoRoot
        ? state
        : { ...state, trustPromptRepoRoot: action.repoRoot };
    case "notes/add-live": {
      assertGeneration(state, action);
      if (action.notes.length === 0) return state;
      const usedIds = liveNoteIds(state);
      const notes = action.notes.map((entry) => {
        const id = allocateNoteId(entry.note.id, usedIds);
        return id === entry.note.id ? entry : { ...entry, note: { ...entry.note, id } };
      });
      return { ...state, liveNotes: [...state.liveNotes, ...notes] };
    }
    case "notes/remove-live": {
      assertGeneration(state, action);
      const index = state.liveNotes.findIndex((entry) => entry.note.id === action.noteId);
      if (index < 0) return state;
      const liveNotes = [...state.liveNotes];
      liveNotes.splice(index, 1);
      return { ...state, liveNotes };
    }
    case "notes/clear-live": {
      assertGeneration(state, action);
      const liveIds = action.noteIds ? new Set(action.noteIds) : undefined;
      const userIds = action.userNoteIds ? new Set(action.userNoteIds) : undefined;
      const keepLive = (entry: ReviewState["liveNotes"][number]) =>
        liveIds
          ? !liveIds.has(entry.note.id)
          : action.fileKey !== undefined && entry.note.fileKey !== action.fileKey;
      const keepUser = (entry: ReviewState["userNotes"][number]) =>
        userIds
          ? !userIds.has(entry.note.id)
          : action.fileKey !== undefined && entry.note.fileKey !== action.fileKey;
      const liveNotes = state.liveNotes.filter(keepLive);
      const userNotes = action.includeUser ? state.userNotes.filter(keepUser) : state.userNotes;
      return liveNotes.length === state.liveNotes.length &&
        userNotes.length === state.userNotes.length
        ? state
        : { ...state, liveNotes, userNotes };
    }
    case "notes/add-user": {
      assertGeneration(state, action);
      const id = allocateNoteId(action.note.note.id, liveNoteIds(state));
      const note =
        id === action.note.note.id
          ? action.note
          : { ...action.note, note: { ...action.note.note, id } };
      return { ...state, userNotes: [...state.userNotes, note] };
    }
    case "notes/update-user": {
      assertGeneration(state, action);
      const index = state.userNotes.findIndex((entry) => entry.note.id === action.noteId);
      if (index < 0) return state;
      const userNotes = [...state.userNotes];
      userNotes[index] = {
        ...action.note,
        note: { ...action.note.note, id: action.noteId },
      };
      return { ...state, userNotes };
    }
    case "notes/remove-user": {
      assertGeneration(state, action);
      const index = state.userNotes.findIndex((entry) => entry.note.id === action.noteId);
      if (index < 0) return state;
      const userNotes = [...state.userNotes];
      userNotes.splice(index, 1);
      return { ...state, userNotes };
    }
    case "draft/start":
      assertGeneration(state, action);
      return draftsEqual(state.draftNote, action.draft)
        ? state
        : { ...state, draftNote: action.draft };
    case "draft/update":
      assertGeneration(state, action);
      return !state.draftNote || state.draftNote.body === action.body
        ? state
        : { ...state, draftNote: { ...state.draftNote, body: action.body } };
    case "draft/cancel":
      assertGeneration(state, action);
      return state.draftNote ? { ...state, draftNote: null } : state;
    case "draft/save": {
      assertGeneration(state, action);
      if (!state.draftNote) return state;
      const id = allocateNoteId(action.note.note.id, liveNoteIds(state));
      const note =
        id === action.note.note.id
          ? action.note
          : { ...action.note, note: { ...action.note.note, id } };
      return { ...state, draftNote: null, userNotes: [...state.userNotes, note] };
    }
    case "expansion/toggle": {
      assertGeneration(state, action);
      const index = state.expandedGaps.findIndex(
        (gap) => gap.fileKey === action.gap.fileKey && gap.gapId === action.gap.gapId,
      );
      if (index >= 0) {
        const current = state.expandedGaps[index]!;
        if (
          current.side === action.gap.side &&
          current.sourceIdentity === action.gap.sourceIdentity &&
          current.expanded === action.gap.expanded &&
          current.oldRange[0] === action.gap.oldRange[0] &&
          current.oldRange[1] === action.gap.oldRange[1] &&
          current.newRange[0] === action.gap.newRange[0] &&
          current.newRange[1] === action.gap.newRange[1]
        )
          return state;
      }
      const expandedGaps = [...state.expandedGaps];
      if (index >= 0) expandedGaps[index] = action.gap;
      else expandedGaps.push(action.gap);
      return { ...state, expandedGaps };
    }
    case "expansion/clear-file": {
      assertGeneration(state, action);
      const expandedGaps = state.expandedGaps.filter((gap) => gap.fileKey !== action.fileKey);
      if (
        expandedGaps.length === state.expandedGaps.length &&
        state.sourceStatusByFileKey[action.fileKey] === undefined
      )
        return state;
      const sourceStatusByFileKey = { ...state.sourceStatusByFileKey };
      delete sourceStatusByFileKey[action.fileKey];
      return { ...state, expandedGaps, sourceStatusByFileKey };
    }
    case "expansion/set-source-status":
      assertGeneration(state, action);
      if (sourceStatusesEqual(state.sourceStatusByFileKey[action.fileKey], action.status)) {
        return state;
      }
      return {
        ...state,
        sourceStatusByFileKey: {
          ...state.sourceStatusByFileKey,
          [action.fileKey]: action.status,
        },
      };
  }
}
