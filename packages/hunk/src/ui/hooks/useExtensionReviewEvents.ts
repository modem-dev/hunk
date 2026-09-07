/**
 * Publishes review events to the current extension runtime.
 *
 * It debounces selection changes, reports hunk-grain attention separately from file object
 * replacement, diffs saved store notes within one review generation, avoids reporting initial
 * filter, layout, and theme values as changes, and exposes stable publishers for command, note,
 * and watch events.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { emitExtensionEvent } from "../../extensions/events";
import { diffExtensionReviewNotes } from "../../extensions/reviewSnapshot";
import type {
  ExtensionEventPayloads,
  ExtensionLayoutMode,
  ExtensionResolvedLayout,
  ExtensionReviewSnapshotNote,
} from "../../extension-api/types";
import type { ExtensionDiffFile, ExtensionLoadResult } from "../../extensions/types";

const EMPTY_REVIEW_NOTES: readonly ExtensionReviewSnapshotNote[] = [];

/** Trailing delay that collapses rapid review navigation into one settled selection event. */
export const SELECTION_CHANGED_DEBOUNCE_MS = 150;

type NoteEventName = "note_created" | "note_edited";

interface RegistryProjectionBaseline<Value> {
  extensions: ExtensionLoadResult | undefined;
  value: Value;
}

/** Timer seam used to make delayed selection retirement deterministic in tests. */
export interface ExtensionReviewEventScheduler {
  setTimeout(callback: () => void, durationMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: ExtensionReviewEventScheduler = {
  setTimeout: (callback, durationMs) => setTimeout(callback, durationMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ExtensionReviewEventPublishers {
  publishCommandExecuted: (commandId: string) => void;
  publishNoteEvent: <Event extends NoteEventName>(
    event: Event,
    payload: ExtensionEventPayloads[Event],
  ) => void;
  publishWatchReloadPending: () => void;
}

/** Publish state-driven review events and return callbacks for action-driven events. */
export function useExtensionReviewEvents({
  extensions,
  filter,
  layoutMode,
  resolvedLayout,
  reviewGeneration = "",
  reviewNotes = EMPTY_REVIEW_NOTES,
  scheduler = defaultScheduler,
  selectedFile,
  selectedFileId,
  selectedHunkIndex,
  themeId,
}: {
  extensions?: ExtensionLoadResult;
  filter: string;
  layoutMode: ExtensionLayoutMode;
  resolvedLayout: ExtensionResolvedLayout;
  reviewGeneration?: string;
  reviewNotes?: readonly ExtensionReviewSnapshotNote[];
  scheduler?: ExtensionReviewEventScheduler;
  selectedFile: ExtensionDiffFile | null | undefined;
  selectedFileId: string | null;
  selectedHunkIndex: number;
  themeId: string;
}): ExtensionReviewEventPublishers {
  // Commands, notes, and watch callbacks publish to the runtime that last committed.
  const activeExtensionsRef = useRef(extensions);
  useLayoutEffect(() => {
    activeExtensionsRef.current = extensions;
    return () => {
      if (activeExtensionsRef.current === extensions) {
        activeExtensionsRef.current = undefined;
      }
    };
  }, [extensions]);

  // Debounce selection changes and treat a replacement file object as a fresh view.
  const selectionGenerationRef = useRef(0);
  const lastViewedFileRef = useRef<{
    extensions: ExtensionLoadResult | undefined;
    file: ExtensionDiffFile;
  } | null>(null);
  const lastViewedHunkRef = useRef<{
    extensions: ExtensionLoadResult | undefined;
    fileId: string;
    hunkIndex: number;
  } | null>(null);
  useEffect(() => {
    const generation = ++selectionGenerationRef.current;
    const targetExtensions = extensions;
    const timer = scheduler.setTimeout(() => {
      // Reject callbacks retired by either a newer selection or registry layout cleanup.
      if (
        selectionGenerationRef.current !== generation ||
        activeExtensionsRef.current !== targetExtensions
      ) {
        return;
      }

      const hunkIndex = selectedFileId === null ? null : selectedHunkIndex;
      emitExtensionEvent(targetExtensions, "selection_changed", {
        fileId: selectedFileId,
        hunkIndex,
      });
      const lastViewed = lastViewedFileRef.current;
      if (
        selectedFile &&
        (!lastViewed ||
          lastViewed.extensions !== targetExtensions ||
          lastViewed.file !== selectedFile)
      ) {
        lastViewedFileRef.current = { extensions: targetExtensions, file: selectedFile };
        emitExtensionEvent(targetExtensions, "file_viewed", { file: selectedFile, hunkIndex });
      }
      if (selectedFile && hunkIndex !== null) {
        const lastHunk = lastViewedHunkRef.current;
        if (
          !lastHunk ||
          lastHunk.extensions !== targetExtensions ||
          lastHunk.fileId !== selectedFile.id ||
          lastHunk.hunkIndex !== hunkIndex
        ) {
          lastViewedHunkRef.current = {
            extensions: targetExtensions,
            fileId: selectedFile.id,
            hunkIndex,
          };
          emitExtensionEvent(targetExtensions, "hunk_viewed", { file: selectedFile, hunkIndex });
        }
      }
    }, SELECTION_CHANGED_DEBOUNCE_MS);

    return () => {
      ++selectionGenerationRef.current;
      scheduler.clearTimeout(timer);
    };
  }, [extensions, scheduler, selectedFile, selectedFileId, selectedHunkIndex]);

  // Seed each runtime's notes without reporting the initial list or a reload remap as changes.
  const reportedNotesRef = useRef<
    | {
        extensions: ExtensionLoadResult | undefined;
        generation: string;
        notes: readonly ExtensionReviewSnapshotNote[];
      }
    | undefined
  >(undefined);
  useEffect(() => {
    const reported = reportedNotesRef.current;
    if (
      reported &&
      reported.extensions === extensions &&
      reported.generation === reviewGeneration
    ) {
      for (const change of diffExtensionReviewNotes(reported.notes, reviewNotes)) {
        emitExtensionEvent(extensions, "note_changed", change);
      }
    }
    reportedNotesRef.current = { extensions, generation: reviewGeneration, notes: reviewNotes };
  }, [extensions, reviewGeneration, reviewNotes]);

  // Seed each runtime's initial filter without reporting it as a change.
  const reportedFilterRef = useRef<RegistryProjectionBaseline<string> | undefined>(undefined);
  useEffect(() => {
    const reported = reportedFilterRef.current;
    if (reported && reported.extensions === extensions && reported.value !== filter) {
      emitExtensionEvent(extensions, "filter_changed", { filter });
    }
    reportedFilterRef.current = { extensions, value: filter };
  }, [extensions, filter]);

  // Report layout changes only after establishing the runtime's initial layout.
  const layoutSignature = `${layoutMode}:${resolvedLayout}`;
  const reportedLayoutRef = useRef<RegistryProjectionBaseline<string> | undefined>(undefined);
  useEffect(() => {
    const reported = reportedLayoutRef.current;
    if (reported && reported.extensions === extensions && reported.value !== layoutSignature) {
      emitExtensionEvent(extensions, "layout_changed", {
        mode: layoutMode,
        layout: resolvedLayout,
      });
    }
    reportedLayoutRef.current = { extensions, value: layoutSignature };
  }, [extensions, layoutMode, layoutSignature, resolvedLayout]);

  // Theme previews stay silent because only the committed theme id reaches this hook.
  const reportedThemeIdRef = useRef<RegistryProjectionBaseline<string> | undefined>(undefined);
  useEffect(() => {
    const reported = reportedThemeIdRef.current;
    if (reported && reported.extensions === extensions && reported.value !== themeId) {
      emitExtensionEvent(extensions, "theme_changed", { themeId });
    }
    reportedThemeIdRef.current = { extensions, value: themeId };
  }, [extensions, themeId]);

  // Keep action publishers stable while resolving the current runtime at call time.
  const publishCommandExecuted = useCallback((commandId: string) => {
    emitExtensionEvent(activeExtensionsRef.current, "command_executed", { commandId });
  }, []);

  const publishNoteEvent = useCallback(
    <Event extends NoteEventName>(event: Event, payload: ExtensionEventPayloads[Event]) => {
      emitExtensionEvent(activeExtensionsRef.current, event, payload);
    },
    [],
  );

  const publishWatchReloadPending = useCallback(() => {
    emitExtensionEvent(activeExtensionsRef.current, "watch_reload_pending", {});
  }, []);

  return {
    publishCommandExecuted,
    publishNoteEvent,
    publishWatchReloadPending,
  };
}
