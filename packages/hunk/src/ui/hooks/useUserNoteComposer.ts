/**
 * Coordinates terminal user-note targeting, draft focus, and public note events.
 * Semantic draft and saved-note transitions remain owned by the terminal review controller.
 */
import { useCallback, useRef, useState } from "react";
import type { ReviewNoteTargetV1 } from "../../core/review/types";
import type { ExtensionEventPayloads, ExtensionReviewNote } from "../../extensions/types";
import type { ActiveAddNoteAffordance } from "../diff/DiffSectionBody";
import type { LineCursor } from "../lib/lineCursors";
import type { DraftReviewNote, UserReviewNote } from "../lib/reviewNoteMapping";

type ActiveAddNoteTarget = ActiveAddNoteAffordance & { fileId: string };
type UserNoteEventPayloads = Pick<ExtensionEventPayloads, "note_created" | "note_edited">;
type ProjectableReviewNote = Pick<
  DraftReviewNote,
  | "id"
  | "fileId"
  | "filePath"
  | "hunkIndex"
  | "side"
  | "line"
  | "parentId"
  | "oldRange"
  | "newRange"
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
    ...(note.oldRange ? { oldRange: note.oldRange } : {}),
    ...(note.newRange ? { newRange: note.newRange } : {}),
    body: note.body ?? note.summary ?? "",
    draft,
  };
}

export interface UseUserNoteComposerOptions {
  draftNote: DraftReviewNote | null;
  /** Whether an implicit keyboard start may use the terminal's current-line cursor. */
  keyboardCursorEnabled: boolean;
  getLineCursor: () => LineCursor | null;
  startDraft: (
    fileId?: string,
    hunkIndex?: number,
    target?: ReviewNoteTargetV1,
    options?: { preserveViewport?: boolean },
  ) => DraftReviewNote | null;
  startEdit?: (noteId: string, options?: { preserveViewport?: boolean }) => DraftReviewNote | null;
  startReply?: (noteId: string, options?: { preserveViewport?: boolean }) => DraftReviewNote | null;
  updateDraft: (body: string, expectedDraftId?: string) => boolean;
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

  /**
   * Printable input that arrived in the same terminal input chunk as the key
   * that opened the draft, before the editor could mount and take focus.
   * OpenTUI delivers one chunk's keys synchronously, so without this the
   * characters would be dispatched as global commands and never reach the note.
   */
  const pendingInputRef = useRef("");
  const awaitingDraftFocusRef = useRef(false);
  const mountingDraftRef = useRef<DraftReviewNote | null>(null);

  /** Arm the transition buffer for a draft whose editor has not mounted yet. */
  const beginDraftFocusTransition = useCallback((draft: DraftReviewNote) => {
    mountingDraftRef.current = draft;
    awaitingDraftFocusRef.current = true;
    pendingInputRef.current = "";
  }, []);

  /** Whether the editor for the current draft has still to mount and take focus. */
  const isDraftFocusPending = useCallback(() => awaitingDraftFocusRef.current, []);

  /** Hold printable input for that draft instead of letting it run commands. */
  const queueDraftInput = useCallback((text: string) => {
    if (awaitingDraftFocusRef.current) {
      pendingInputRef.current += text;
    }
  }, []);

  /** Take the held input once the mounted editor owns the keyboard. */
  const takePendingDraftInput = useCallback(() => {
    awaitingDraftFocusRef.current = false;
    mountingDraftRef.current = null;
    const pending = pendingInputRef.current;
    pendingInputRef.current = "";
    return pending;
  }, []);

  /** Drop held input along with a cancelled draft. */
  const discardPendingDraftInput = useCallback(() => {
    awaitingDraftFocusRef.current = false;
    mountingDraftRef.current = null;
    pendingInputRef.current = "";
  }, []);

  /** Start a draft at an explicit target, hovered affordance, or enabled line cursor. */
  const startUserNote = useCallback(
    (fileId?: string, hunkIndex?: number, target?: ReviewNoteTargetV1) => {
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
        beginDraftFocusTransition(draft);
        focusDraft();
      }
      return draft;
    },
    [
      activeAddNoteTarget,
      beginDraftFocusTransition,
      focusDraft,
      getLineCursor,
      keyboardCursorEnabled,
      startDraft,
    ],
  );

  /** Open one saved user note for editing and transfer keyboard ownership. */
  const startUserNoteEdit = useCallback(
    (noteId: string, options?: { preserveViewport?: boolean }) => {
      const draft = startEdit(noteId, options);
      if (draft) {
        setActiveAddNoteTarget(null);
        beginDraftFocusTransition(draft);
        focusDraft();
      }
      return draft;
    },
    [beginDraftFocusTransition, focusDraft, startEdit],
  );

  /** Open a reply composer and transfer keyboard ownership. */
  const startUserNoteReply = useCallback(
    (noteId: string, options?: { preserveViewport?: boolean }) => {
      const draft = startReply(noteId, options);
      if (draft) {
        setActiveAddNoteTarget(null);
        beginDraftFocusTransition(draft);
        focusDraft();
      }
      return draft;
    },
    [beginDraftFocusTransition, focusDraft, startReply],
  );

  /** Mark the mounted draft editor as the active keyboard input. */
  const focusDraftNote = useCallback(() => {
    focusDraft();
  }, [focusDraft]);

  /** Return keyboard ownership according to the host's draft-blur policy. */
  const blurDraftNote = useCallback(() => {
    // Leaving the draft abandons the transition: input typed after the blur is
    // no longer that note's, and must not be replayed into it on the next focus.
    discardPendingDraftInput();
    blurDraftFocus();
  }, [blurDraftFocus, discardPendingDraftInput]);

  /** Save the current draft, publish it once, and return to review navigation. */
  const saveDraftNote = useCallback(
    (editorBody?: string) => {
      // `saveDraft` consumes the semantic draft synchronously. Retain its runtime file id
      // first because the saved terminal projection is keyed by path rather than runtime id.
      // Opening and saving can share an input chunk before React commits the draft prop.
      const priorDraft = mountingDraftRef.current ?? draftNote;
      const pendingInput = takePendingDraftInput();
      // OpenTUI initializes a new textarea at the beginning of its initial body.
      const body =
        editorBody ??
        (pendingInput.length > 0 ? pendingInput + (priorDraft?.body ?? "") : undefined);
      if (priorDraft && body !== undefined && !updateDraft(body, priorDraft.id)) {
        return;
      }
      const saved = saveDraft();
      if (saved && priorDraft) {
        const note = projectExtensionReviewNote({ ...saved, fileId: priorDraft.fileId }, false);
        publishEvent(priorDraft.kind === "edit" ? "note_edited" : "note_created", { note });
      }
      focusReview();
    },
    [draftNote, focusReview, publishEvent, saveDraft, takePendingDraftInput, updateDraft],
  );

  /** Update the semantic draft and publish the body supplied by the editor. */
  const updateDraftNote = useCallback(
    (body: string) => {
      const priorDraft = draftNote;
      if (!priorDraft || !updateDraft(body, priorDraft.id)) {
        return;
      }
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
    },
    [draftNote, publishEvent, updateDraft],
  );

  /** Cancel the semantic draft and return to review navigation. */
  const cancelDraftNote = useCallback(() => {
    discardPendingDraftInput();
    cancelDraft();
    focusReview();
  }, [cancelDraft, discardPendingDraftInput, focusReview]);

  return {
    blurDraftNote,
    cancelDraftNote,
    focusDraftNote,
    isDraftFocusPending,
    onActiveAddNoteAffordanceChange: setActiveAddNoteTarget,
    queueDraftInput,
    saveDraftNote,
    startUserNote,
    startUserNoteEdit,
    startUserNoteReply,
    takePendingDraftInput,
    updateDraftNote,
  };
}
