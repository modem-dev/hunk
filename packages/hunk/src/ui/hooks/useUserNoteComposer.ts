/**
 * Coordinates terminal user-note targeting, draft focus, and public note events.
 * Semantic draft and saved-note transitions remain owned by the terminal review controller.
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { UserNoteLineTarget } from "../../core/liveComments";
import type { ExtensionEventPayloads, ExtensionReviewNote } from "../../extensions/types";
import type { ActiveAddNoteAffordance } from "../diff/DiffSectionBody";
import type { LineCursor } from "../lib/lineCursors";
import type { DraftReviewNote, UserReviewNote } from "../lib/reviewNoteMapping";

type ActiveAddNoteTarget = ActiveAddNoteAffordance & { fileId: string };
type UserNoteEventPayloads = Pick<ExtensionEventPayloads, "note_created" | "note_edited">;
type ProjectableReviewNote = Pick<
  DraftReviewNote,
  "id" | "fileId" | "filePath" | "hunkIndex" | "side" | "line" | "parentId"
> & {
  body?: string;
  summary?: string;
};

/** Publish one user-note lifecycle event through the host-provided event seam. */
export type UserNoteEventPublisher = <Event extends keyof UserNoteEventPayloads>(
  event: Event,
  payload: UserNoteEventPayloads[Event],
) => void;

/** Project a terminal note into the stable public extension event shape. */
export function projectExtensionReviewNote(
  note: ProjectableReviewNote,
  draft: boolean,
): ExtensionReviewNote {
  return {
    id: note.id,
    ...(note.parentId ? { parentId: note.parentId } : {}),
    fileId: note.fileId,
    filePath: note.filePath,
    hunkIndex: note.hunkIndex,
    side: note.side,
    line: note.line,
    body: note.body ?? note.summary ?? "",
    draft,
  };
}

export interface UseUserNoteComposerOptions {
  draftNote: DraftReviewNote | null;
  /** Read semantic draft identity before delivering deferred native editor events. */
  getDraftNoteId: () => string | null;
  /** Whether an implicit keyboard start may use the terminal's current-line cursor. */
  keyboardCursorEnabled: boolean;
  getLineCursor: () => LineCursor | null;
  startDraft: (
    fileId?: string,
    hunkIndex?: number,
    target?: UserNoteLineTarget,
    options?: { preserveViewport?: boolean },
  ) => DraftReviewNote | null;
  startEdit?: (noteId: string, options?: { preserveViewport?: boolean }) => DraftReviewNote | null;
  startReply?: (noteId: string, options?: { preserveViewport?: boolean }) => DraftReviewNote | null;
  updateDraft: (body: string) => void;
  saveDraft: () => UserReviewNote | null;
  cancelDraft: () => void;
  focus: {
    /** Move keyboard ownership into the draft editor. */
    draft: () => void;
    /** Return keyboard ownership to review navigation. */
    review: () => void;
    /** Handle the draft editor losing renderable focus. */
    blurDraft: () => void;
  };
  publishEvent: UserNoteEventPublisher;
}

/** Coordinate one terminal user-note composition flow around shared semantic actions. */
export function useUserNoteComposer({
  draftNote,
  getDraftNoteId,
  keyboardCursorEnabled,
  getLineCursor,
  startDraft,
  startEdit = () => null,
  startReply = () => null,
  updateDraft,
  saveDraft,
  cancelDraft,
  focus,
  publishEvent,
}: UseUserNoteComposerOptions) {
  const [activeAddNoteTarget, setActiveAddNoteTarget] = useState<ActiveAddNoteTarget | null>(null);
  const { draft: focusDraft, review: focusReview, blurDraft: blurDraftFocus } = focus;
  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** Ignore editor callbacks after their draft is consumed, replaced, or unmounted. */
  const isCurrentDraft = useCallback(
    () => mountedRef.current && draftNote !== null && getDraftNoteId() === draftNote.id,
    [draftNote, getDraftNoteId],
  );

  /** Start a draft at an explicit target, hovered affordance, or enabled line cursor. */
  const startUserNote = useCallback(
    (fileId?: string, hunkIndex?: number, target?: UserNoteLineTarget) => {
      // Hover and the current line are fallbacks only for a fully implicit start. Any
      // explicit location fact must not inherit whichever row happened to remain hovered.
      const hasExplicitTarget =
        fileId !== undefined || hunkIndex !== undefined || target !== undefined;
      const hoverTarget = hasExplicitTarget ? null : activeAddNoteTarget;
      const implicitTarget =
        hoverTarget ?? (!hasExplicitTarget && keyboardCursorEnabled ? getLineCursor() : null);
      const draft = startDraft(
        fileId ?? implicitTarget?.fileId,
        hunkIndex ?? implicitTarget?.hunkIndex,
        target ?? implicitTarget?.target,
        { preserveViewport: hasExplicitTarget || implicitTarget !== null },
      );
      if (draft) {
        setActiveAddNoteTarget(null);
        focusDraft();
      }
      return draft;
    },
    [activeAddNoteTarget, focusDraft, getLineCursor, keyboardCursorEnabled, startDraft],
  );

  /** Open one saved user note for editing and transfer keyboard ownership. */
  const startUserNoteEdit = useCallback(
    (noteId: string, options?: { preserveViewport?: boolean }) => {
      const draft = startEdit(noteId, options);
      if (draft) {
        setActiveAddNoteTarget(null);
        focusDraft();
      }
      return draft;
    },
    [focusDraft, startEdit],
  );

  /** Open a reply composer and transfer keyboard ownership. */
  const startUserNoteReply = useCallback(
    (noteId: string, options?: { preserveViewport?: boolean }) => {
      const draft = startReply(noteId, options);
      if (draft) {
        setActiveAddNoteTarget(null);
        focusDraft();
      }
      return draft;
    },
    [focusDraft, startReply],
  );

  /** Mark the mounted draft editor as the active keyboard input. */
  const focusDraftNote = useCallback(() => {
    focusDraft();
  }, [focusDraft]);

  /** Return keyboard ownership according to the host's draft-blur policy. */
  const blurDraftNote = useCallback(() => {
    blurDraftFocus();
  }, [blurDraftFocus]);

  /** Save after OpenTUI publishes native edits queued earlier in this input batch. */
  const saveDraftNote = useCallback(() => {
    queueMicrotask(() => {
      if (!isCurrentDraft()) return;
      // Native content-change events are microtasks. Consume the semantic draft only
      // after those preceding edits have arrived, including a final character before Ctrl-S.
      const priorDraft = draftNote;
      const saved = saveDraft();
      if (saved && priorDraft) {
        const note = projectExtensionReviewNote({ ...saved, fileId: priorDraft.fileId }, false);
        publishEvent(priorDraft.kind === "edit" ? "note_edited" : "note_created", { note });
      }
      focusReview();
    });
  }, [draftNote, focusReview, isCurrentDraft, publishEvent, saveDraft]);

  /** Update the semantic draft and publish the body supplied by the editor. */
  const updateDraftNote = useCallback(
    (body: string) => {
      if (!isCurrentDraft()) return;
      const priorDraft = draftNote;
      updateDraft(body);
      if (priorDraft) {
        publishEvent("note_edited", {
          note: projectExtensionReviewNote(
            {
              ...priorDraft,
              id:
                priorDraft.kind === "edit" && priorDraft.targetNoteId
                  ? priorDraft.targetNoteId
                  : priorDraft.id,
              body,
            },
            true,
          ),
        });
      }
    },
    [draftNote, isCurrentDraft, publishEvent, updateDraft],
  );

  /** Let queued native edits settle before cancelling their semantic draft. */
  const cancelDraftNote = useCallback(() => {
    queueMicrotask(() => {
      if (!isCurrentDraft()) return;
      cancelDraft();
      focusReview();
    });
  }, [cancelDraft, focusReview, isCurrentDraft]);

  return {
    blurDraftNote,
    cancelDraftNote,
    focusDraftNote,
    onActiveAddNoteAffordanceChange: setActiveAddNoteTarget,
    saveDraftNote,
    startUserNote,
    startUserNoteEdit,
    startUserNoteReply,
    updateDraftNote,
  };
}
