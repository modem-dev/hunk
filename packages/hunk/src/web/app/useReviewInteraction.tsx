/** @jsxImportSource react */
/**
 * The page's writing side: note composers, note actions, the shared toggles, and refresh.
 *
 * Every gesture that changes the review converges here — keys (`c`, `E`, `R`, `D`, `a`, `r`,
 * the save chord), card buttons, gutter clicks and line drags, the filter field, and the
 * refresh button — and leaves as one review action through `session.actions`, or as the
 * refresh route. Which note a key means comes from the shared lowering
 * (`lowerAppCommandToReviewIntent`), exactly as in the terminal; the page then writes with the
 * direct intents rather than the shared draft slot. Note visibility and the filter are shared
 * review state by product decision, so they are posted, and the page shows them once the
 * shared state echoes them back.
 *
 * Owns no review state. Composers live in `session.composers`, failures with no nearer place go
 * to `session.toasts`, and everything the page shows still comes from the mirrors.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reviewDefaultHunkLineTarget } from "../../core/review/geometry";
import { reviewNoteRangeLabel } from "../../core/review/noteLabels";
import { selectStoredReviewNoteById } from "../../core/review/selectors";
import { reviewNoteOwnerHunkIndex } from "../../core/review/state";
import type { ReviewSide } from "../../core/review/types";
import {
  lowerAppCommandToReviewIntent,
  type AppCommandCatalogEntry,
} from "../../core/run/commandCatalog";
import type { ReviewSharedStateV1 } from "../../session/reviewSharedState";
import { reviewActionFailure } from "../actions/reviewActions";
import { REVIEW_SESSION_ENDED_MESSAGE } from "../session/failureMessages";
import type { NoteComposer } from "../notes/composerStore";
import { NoteComposerView } from "../notes/NoteComposerView";
import { noteRemovalAction, saveNoteComposer } from "../notes/noteActions";
import type { WebNoteCardAction } from "../notes/noteCards";
import type { ReviewNoteInteraction } from "../notes/noteInteraction";
import { reviewNotePlacement } from "../notes/noteProjection";
import { reviewNoteLineTarget, reviewNoteRangeTarget } from "../notes/noteTargets";
import type { ReviewSession } from "../session/reviewSession";
import { planReviewFileRender } from "../stream/fileProjection";
import { FilterEditSequence } from "./filterEdits";

/** How long the filter field waits for typing to pause before it sets the shared filter. */
export const FILTER_DEBOUNCE_MS = 300;

/** Where one composer goes, in the words its header shows. */
function composerLocation(composer: NoteComposer) {
  if (composer.target && "preferred" in composer.target)
    return reviewNoteRangeLabel(composer.target);
  return reviewNoteRangeLabel(
    composer.side === "old"
      ? { oldRange: [composer.line, composer.line] }
      : { newRange: [composer.line, composer.line] },
  );
}

/** The page's writing side for one session. */
export function useReviewInteraction(
  session: ReviewSession,
  shared: ReviewSharedStateV1 | undefined,
  sessionEnded = false,
) {
  const { composers, actions, toasts, review } = session;
  // Opening a composer or refreshing after the session ended would write to nothing; say so
  // once, in the same words as a refused send, instead of opening a form that cannot save.
  const endedRef = useRef(sessionEnded);
  endedRef.current = sessionEnded;
  const refuseIfEnded = useCallback(() => {
    if (!endedRef.current) return false;
    toasts.show(REVIEW_SESSION_ENDED_MESSAGE);
    return true;
  }, [toasts]);

  /** The file as the page shows it, its gaps, and its drawn hunks. */
  const fileView = useCallback(
    (fileKey: string) => {
      const state = review.store.getSnapshot();
      const file = state.document.files.find((candidate) => candidate.key === fileKey);
      if (!file) return undefined;
      const plan = planReviewFileRender(file, state);
      return { file, plan, drawn: plan.metadata?.hunks ?? file.hunks };
    },
    [review],
  );

  /** Open a composer for a new note on lines the reader picked. */
  const openOnLines = useCallback(
    (fileKey: string, side: ReviewSide, start: number, end: number) => {
      if (refuseIfEnded()) return;
      const view = fileView(fileKey);
      if (!view) return;
      const pick = reviewNoteRangeTarget(view.file, view.plan.gaps, side, start, end);
      if (!pick) return;
      composers.open({
        kind: "new",
        fileKey,
        hunkIndex: pick.hunkIndex,
        side: pick.side,
        line: pick.line,
        target: pick.target,
        ...(pick.expandedLineProof ? { expandedLineProof: pick.expandedLineProof } : {}),
        contentIdentity: view.file.contentIdentity,
      });
    },
    [composers, fileView, refuseIfEnded],
  );

  /** Open a composer replying to, or editing, one stored note. */
  const openOnNote = useCallback(
    (kind: "reply" | "edit", noteId: string) => {
      if (refuseIfEnded()) return;
      const state = review.store.getSnapshot();
      const entry = selectStoredReviewNoteById(state, noteId);
      const view = entry ? fileView(entry.note.fileKey) : undefined;
      if (!entry || !view) return;
      const placement = reviewNotePlacement(entry.note, { hunks: view.drawn });
      composers.open({
        kind,
        fileKey: entry.note.fileKey,
        hunkIndex: reviewNoteOwnerHunkIndex(entry.note),
        side: placement.side,
        line: placement.line,
        ...(kind === "reply" ? { parentId: noteId } : { noteId, body: entry.note.summary }),
        contentIdentity: view.file.contentIdentity,
      });
    },
    [composers, fileView, refuseIfEnded, review],
  );

  /** Open a composer for a new note on the selected hunk's default line (`c`). */
  const openOnSelection = useCallback(() => {
    if (refuseIfEnded()) return;
    const { selection } = review.store.getSnapshot();
    const view = selection.fileKey ? fileView(selection.fileKey) : undefined;
    const hunk = view?.file.hunks[selection.hunkIndex];
    if (!view || !hunk || !selection.fileKey) return;
    const line = reviewDefaultHunkLineTarget(hunk);
    const pick = reviewNoteLineTarget(view.file, view.plan.gaps, line.side, line.line);
    composers.open({
      kind: "new",
      fileKey: selection.fileKey,
      hunkIndex: selection.hunkIndex,
      side: line.side,
      line: line.line,
      ...(pick ? { target: pick.target } : {}),
      contentIdentity: view.file.contentIdentity,
    });
  }, [composers, fileView, refuseIfEnded, review]);

  /** Remove one stored note, as the terminal's `D` does. */
  const removeNote = useCallback(
    async (noteId: string) => {
      const entry = selectStoredReviewNoteById(review.store.getSnapshot(), noteId);
      if (!entry) return;
      const outcome = await actions.send(noteRemovalAction(entry.note));
      if (!outcome.ok) toasts.show(outcome.message);
    },
    [actions, review, toasts],
  );

  /** Make one note the active one, where `E`, `R`, and `D` act. */
  const selectNote = useCallback(
    (fileKey: string, noteId: string) => {
      const entry = selectStoredReviewNoteById(review.store.getSnapshot(), noteId);
      if (!entry) return;
      review.apply({
        type: "selection/select",
        fileKey,
        hunkIndex: reviewNoteOwnerHunkIndex(entry.note),
        reveal: { anchor: "none", scrollToNote: false },
        activeNoteId: noteId,
      });
    },
    [review],
  );

  const save = useCallback(
    async (composer: NoteComposer) => {
      await saveNoteComposer(
        composer,
        composers,
        actions,
        (fileKey) =>
          session.mirror.getSnapshot().document.files.find((file) => file.key === fileKey)
            ?.contentIdentity,
      );
    },
    [actions, composers, session],
  );

  // Composers render from the store's latest copy, so typing never waits on a prop chain.
  const renderComposer = useCallback(
    (composer: NoteComposer) => (
      <NoteComposerView
        composer={composer}
        location={composerLocation(composer)}
        onChange={(body) => composers.update(composer.key, { body, status: "editing" })}
        onSave={() => void save(composers.getSnapshot().find((c) => c.key === composer.key)!)}
        onCancel={() => composers.close(composer.key)}
        sessionEnded={sessionEnded}
      />
    ),
    [composers, save, sessionEnded],
  );

  const interaction: ReviewNoteInteraction = useMemo(
    () => ({
      renderComposer,
      onPickLines: openOnLines,
      onNoteAction: (fileKey: string, action: WebNoteCardAction | "select", noteId: string) => {
        if (action === "select") selectNote(fileKey, noteId);
        else if (action === "delete") void removeNote(noteId);
        else openOnNote(action, noteId);
      },
    }),
    [openOnLines, openOnNote, removeNote, renderComposer, selectNote],
  );

  // A sent composer closes once the shared state shows what it wrote; a restored draft whose
  // file changed underneath it says so.
  useEffect(() => {
    if (shared) {
      composers.settleSent({ generation: shared.generation, stateRevision: shared.stateRevision });
    }
  }, [composers, shared]);
  const documentFiles = review.store.getSnapshot().document.files;
  useEffect(() => {
    if (documentFiles.length === 0) return;
    composers.reconcileContent(
      new Map(documentFiles.map((file) => [file.key, file.contentIdentity])),
    );
  }, [composers, documentFiles]);

  /** Run a note key (`E`, `R`, `D`) on the note the shared lowering names. */
  const noteCommand = useCallback(
    (entry: AppCommandCatalogEntry) => {
      const intent = lowerAppCommandToReviewIntent(entry, {
        count: 1,
        state: review.store.getSnapshot(),
      });
      if (!intent) return;
      if (intent.type === "notes/start-edit") openOnNote("edit", intent.noteId);
      else if (intent.type === "notes/start-reply") openOnNote("reply", intent.noteId);
      else if (intent.type === "notes/remove-user" || intent.type === "notes/remove-live") {
        void removeNote(intent.noteId);
      }
    },
    [openOnNote, removeNote, review],
  );

  /** Save the composer that holds focus (`hunk.review.saveNote`). */
  const saveFocused = useCallback(() => {
    const key = (document.activeElement?.closest("[data-composer-key]") as HTMLElement | null)
      ?.dataset.composerKey;
    const composer = composers.getSnapshot().find((candidate) => candidate.key === key);
    if (composer) void save(composer);
  }, [composers, save]);

  /** Flip agent-note visibility for every surface (`a`). */
  const toggleAgentNotes = useCallback(async () => {
    const outcome = await actions.send({
      type: "notes/set-visibility",
      visible: !review.store.getSnapshot().showAgentNotes,
    });
    if (!outcome.ok) toasts.show(outcome.message);
  }, [actions, review, toasts]);

  // The filter field: local text, sent once typing pauses, replaced by the shared value when
  // another surface changes it while the field is idle.
  const [filterText, setFilterText] = useState(shared?.filter ?? "");
  const filterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const filterEdits = useRef(new FilterEditSequence());
  useEffect(() => {
    if (!filterEdits.current.editing) setFilterText(shared?.filter ?? "");
  }, [shared?.filter]);
  useEffect(() => () => clearTimeout(filterTimer.current), []);
  const changeFilter = useCallback(
    (text: string) => {
      setFilterText(text);
      const sequence = filterEdits.current.edit();
      clearTimeout(filterTimer.current);
      filterTimer.current = setTimeout(async () => {
        const outcome = await actions.send({ type: "filter/set", filter: text });
        filterEdits.current.settle(sequence);
        if (!outcome.ok) toasts.show(outcome.message);
      }, FILTER_DEBOUNCE_MS);
    },
    [actions, toasts],
  );

  // Refresh: the session reopens its input, paced by the session; the page shows it working.
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    if (refreshing || refuseIfEnded()) return;
    setRefreshing(true);
    try {
      await session.client.refresh();
    } catch (error) {
      toasts.show(reviewActionFailure(error).message);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, refuseIfEnded, session, toasts]);

  return {
    interaction,
    openOnSelection,
    noteCommand,
    saveFocused,
    toggleAgentNotes,
    filterText,
    changeFilter,
    refreshing,
    refresh,
  };
}
