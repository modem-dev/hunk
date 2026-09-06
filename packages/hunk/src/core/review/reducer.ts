/**
 * Applies one action to the review state and returns the next state.
 *
 * Runs synchronously with no I/O. An action that changes nothing returns the
 * previous state object, so observers can skip work with an identity check.
 * Timestamps and ids never originate here — callers put them on the action.
 */
import type { ReviewAction } from "./actions";
import { clamp } from "./navigation";
import {
  isReviewNoteWithinClearScope,
  reviewFileKeysWithRetiredContent,
  selectReviewFileByKey,
} from "./selectors";
import {
  applyReviewRevealRequest,
  reviewRevealIntentsEqual,
  type ReviewSourceStatus,
  type ReviewState,
  type ReviewStoredNote,
} from "./state";

/** Compare renderer-neutral source statuses by semantic value. */
function sourceStatusesEqual(left: ReviewSourceStatus | undefined, right: ReviewSourceStatus) {
  if (!left || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "loaded" && right.kind === "loaded") {
    return left.text === right.text;
  }
  if (left.kind === "error" && right.kind === "error") {
    return left.reason === right.reason;
  }
  return true;
}

/** Drop one note by id from a stored-note list, or return the same list when absent. */
function withoutNote(notes: ReviewStoredNote[], noteId: string) {
  const index = notes.findIndex((entry) => entry.note.id === noteId);
  if (index < 0) {
    return notes;
  }
  const next = [...notes];
  next.splice(index, 1);
  return next;
}

/** Apply one named semantic action without renderer or framework dependencies. */
export function reduceReviewState(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case "document/reconcile": {
      if (action.document === state.document) {
        return state;
      }
      // Selection reconciliation is not done here: which file becomes selected when the
      // current one disappears depends on the consumer's visible stream, so consumers
      // dispatch the follow-up selection they want.
      const retired = reviewFileKeysWithRetiredContent(state.document, action.document);
      const expandedGaps = state.expandedGaps.filter((gap) => !retired.has(gap.fileKey));
      // Loaded text is a cache of what a reader returned, not a fact of the diff: it
      // survives a reload only when the file's reader attested its snapshot. Unattested
      // text is dropped so an open gap refetches instead of rendering lines the source
      // may no longer contain; the gap itself stays open either way.
      const attested = new Set(
        action.document.files.filter((file) => file.sourceAttested).map((file) => file.key),
      );
      const sourceStatusByFileKey = Object.fromEntries(
        Object.entries(state.sourceStatusByFileKey).filter(
          ([fileKey]) => !retired.has(fileKey) && attested.has(fileKey),
        ),
      );
      return { ...state, document: action.document, expandedGaps, sourceStatusByFileKey };
    }
    case "selection/select": {
      const file = selectReviewFileByKey(state, action.fileKey);
      if (!file) {
        return state;
      }
      const hunkIndex = clamp(action.hunkIndex, 0, Math.max(0, file.hunks.length - 1));
      const selectionChanged =
        file.key !== state.selection.fileKey || hunkIndex !== state.selection.hunkIndex;
      const reveal = action.reveal
        ? applyReviewRevealRequest(state.reveal, action.reveal)
        : state.reveal;
      if (!selectionChanged && reviewRevealIntentsEqual(reveal, state.reveal)) {
        return state;
      }
      return { ...state, selection: { fileKey: file.key, hunkIndex }, reveal };
    }
    case "filter/set":
      return action.filter === state.filter ? state : { ...state, filter: action.filter };
    case "notes/set-visibility":
      return action.visible === state.showAgentNotes
        ? state
        : { ...state, showAgentNotes: action.visible };
    case "notes/add-live":
      return action.notes.length === 0
        ? state
        : { ...state, liveNotes: [...state.liveNotes, ...action.notes] };
    case "notes/remove-live": {
      const liveNotes = withoutNote(state.liveNotes, action.noteId);
      return liveNotes === state.liveNotes ? state : { ...state, liveNotes };
    }
    case "notes/clear": {
      const keep = (entry: ReviewStoredNote) =>
        !isReviewNoteWithinClearScope(entry, action.fileKey);
      const liveNotes = state.liveNotes.filter(keep);
      const userNotes = action.includeUser ? state.userNotes.filter(keep) : state.userNotes;
      return liveNotes.length === state.liveNotes.length &&
        userNotes.length === state.userNotes.length
        ? state
        : { ...state, liveNotes, userNotes };
    }
    case "notes/remove-user": {
      const userNotes = withoutNote(state.userNotes, action.noteId);
      return userNotes === state.userNotes ? state : { ...state, userNotes };
    }
    case "draft/start":
      return { ...state, draftNote: action.draft };
    case "draft/update":
      return !state.draftNote || state.draftNote.body === action.body
        ? state
        : { ...state, draftNote: { ...state.draftNote, body: action.body } };
    case "draft/cancel":
      return state.draftNote ? { ...state, draftNote: null } : state;
    case "draft/save":
      return state.draftNote
        ? { ...state, draftNote: null, userNotes: [...state.userNotes, action.note] }
        : state;
    case "draft/save-edit": {
      if (!state.draftNote) {
        return state;
      }
      const index = state.userNotes.findIndex((entry) => entry.note.id === action.note.note.id);
      if (index < 0) {
        return state;
      }
      const userNotes = [...state.userNotes];
      userNotes[index] = action.note;
      return { ...state, draftNote: null, userNotes };
    }
    case "expansion/toggle": {
      const index = state.expandedGaps.findIndex(
        (gap) => gap.fileKey === action.fileKey && gap.gapId === action.gapId,
      );
      if (index >= 0 && state.expandedGaps[index]!.expanded === action.expanded) {
        return state;
      }
      const gap = { fileKey: action.fileKey, gapId: action.gapId, expanded: action.expanded };
      const expandedGaps = [...state.expandedGaps];
      if (index >= 0) {
        expandedGaps[index] = gap;
      } else {
        expandedGaps.push(gap);
      }
      return { ...state, expandedGaps };
    }
    case "expansion/set-source-status":
      return sourceStatusesEqual(state.sourceStatusByFileKey[action.fileKey], action.status)
        ? state
        : {
            ...state,
            sourceStatusByFileKey: {
              ...state.sourceStatusByFileKey,
              [action.fileKey]: action.status,
            },
          };
  }
}
