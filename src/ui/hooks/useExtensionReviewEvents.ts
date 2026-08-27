/**
 * Publishes extension-facing events as users move through and operate on the mounted review.
 *
 * Selection settling, file viewing, filtering, layout changes, and committed theme changes all
 * converge here so debounce and initial-suppression behavior follows the active extension runtime.
 * App keeps ownership of user actions and command composition, while this hook exposes narrow
 * publishers for watch, note, and command events triggered by those workflows.
 *
 * Replacing or unmounting an extension runtime retires its delayed selection work. Each replacement
 * establishes silent filter, layout, and theme baselines, then receives the current selection and
 * file view even when a soft reload preserves the file's stable id.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { emitExtensionEvent } from "../../extensions/events";
import type {
  ExtensionEventPayloads,
  ExtensionLayoutMode,
  ExtensionResolvedLayout,
} from "../../extension-api/types";
import type { ExtensionDiffFile, ExtensionLoadResult } from "../../extensions/types";

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

/** Coordinate declarative review events and return stable publishers for imperative events. */
export function useExtensionReviewEvents({
  extensions,
  filter,
  layoutMode,
  resolvedLayout,
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
  scheduler?: ExtensionReviewEventScheduler;
  selectedFile: ExtensionDiffFile | null | undefined;
  selectedFileId: string | null;
  selectedHunkIndex: number;
  themeId: string;
}): ExtensionReviewEventPublishers {
  const activeExtensionsRef = useRef(extensions);
  useLayoutEffect(() => {
    activeExtensionsRef.current = extensions;
    return () => {
      if (activeExtensionsRef.current === extensions) {
        activeExtensionsRef.current = undefined;
      }
    };
  }, [extensions]);

  const selectionGenerationRef = useRef(0);
  const lastViewedFileRef = useRef<{
    extensions: ExtensionLoadResult | undefined;
    file: ExtensionDiffFile;
  } | null>(null);
  useEffect(() => {
    const generation = ++selectionGenerationRef.current;
    const targetExtensions = extensions;
    const timer = scheduler.setTimeout(() => {
      // Layout cleanup retires a registry before passive effect cleanup cancels this timer.
      // Checking both guards closes that commit-to-cleanup window without changing debounce.
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
    }, SELECTION_CHANGED_DEBOUNCE_MS);

    return () => {
      ++selectionGenerationRef.current;
      scheduler.clearTimeout(timer);
    };
  }, [extensions, scheduler, selectedFile, selectedFileId, selectedHunkIndex]);

  const reportedFilterRef = useRef<RegistryProjectionBaseline<string> | undefined>(undefined);
  useEffect(() => {
    const reported = reportedFilterRef.current;
    if (reported && reported.extensions === extensions && reported.value !== filter) {
      emitExtensionEvent(extensions, "filter_changed", { filter });
    }
    reportedFilterRef.current = { extensions, value: filter };
  }, [extensions, filter]);

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

  const reportedThemeIdRef = useRef<RegistryProjectionBaseline<string> | undefined>(undefined);
  useEffect(() => {
    const reported = reportedThemeIdRef.current;
    if (reported && reported.extensions === extensions && reported.value !== themeId) {
      emitExtensionEvent(extensions, "theme_changed", { themeId });
    }
    reportedThemeIdRef.current = { extensions, value: themeId };
  }, [extensions, themeId]);

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
