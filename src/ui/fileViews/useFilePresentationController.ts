import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile } from "../../core/types";
import type { ExtensionDiffFile, ExtensionReviewSelection } from "../../extension-api/types";
import { toReadOnlyFileViews } from "../../extensions/events";
import type { ExtensionFileViewControls, RegisteredFileView } from "../../extensions/types";
import type { MenuEntry } from "../components/chrome/menu";
import { availableFileViewSelections, fileViewUnavailableReason } from "./availability";
import {
  bumpFileViewEpoch,
  reconcileFileViewEpochs,
  reconcileFileViewSelections,
  registeredFileViewKey,
  resolveBulkFileViewTarget,
  resolveRegisteredFileView,
  selectFileView,
  selectFileViewForFiles,
  type FileViewEpochState,
  type FileViewSelectionState,
} from "./state";

export interface FilePresentationController {
  /** Stored choices with temporarily unavailable files omitted for rendering. */
  availableSelections: FileViewSelectionState;
  /** Layout invalidation epochs requested by stateful extension views. */
  epochs: FileViewEpochState;
  bulkTarget: { readonly title: string } | null;
  menuEntries: readonly MenuEntry[];
  /** Build live host-owned file-presentation controls for one extension command. */
  createControls: (extensionId: string) => ExtensionFileViewControls;
  applyBulkTarget: () => void;
}

/** Own host file-presentation selection, availability, controls, bulk, and menu state. */
export function useFilePresentationController({
  files,
  visibleFiles,
  selectedFile,
  draftFileId,
  views,
  getVisibleFileViews,
  getSelectedFileId,
  getExtensionSelection,
  showNotice,
}: {
  /** Complete review order, including files hidden by the current filter. */
  files: readonly DiffFile[];
  /** Files currently visible in the review stream. */
  visibleFiles: readonly DiffFile[];
  selectedFile: DiffFile | undefined;
  draftFileId: string | null;
  views: readonly RegisteredFileView[];
  /** Shared frozen extension views used by sidebars and command snapshots. */
  getVisibleFileViews: () => readonly ExtensionDiffFile[];
  /** Live selected id, intentionally separate from the frozen public selection. */
  getSelectedFileId: () => string | null;
  /** Invocation-time frozen selection used when testing a view registration. */
  getExtensionSelection: () => ExtensionReviewSelection;
  showNotice: (message: string) => void;
}): FilePresentationController {
  // Raw is implicit, so an empty state is the guaranteed default and fallback.
  const [selections, setSelections] = useState<FileViewSelectionState>({});
  // A registration replacement already invalidates prepared layouts; these counters cover state
  // changes inside one stable registration for the lifetime of this controller.
  const [epochs, setEpochs] = useState<FileViewEpochState>(() => new Map<string, number>());
  const selectionsRef = useRef(selections);
  selectionsRef.current = selections;
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const fileIds = useMemo(() => new Set(files.map((file) => file.id)), [files]);
  const fileIdsRef = useRef<ReadonlySet<string>>(fileIds);
  fileIdsRef.current = fileIds;

  const unavailableReasons = useMemo(() => {
    const reasons = new Map<string, string>();
    for (const file of visibleFiles) {
      const reason = fileViewUnavailableReason({ hasDraftNote: draftFileId === file.id });
      if (reason) reasons.set(file.id, reason);
    }
    return reasons;
  }, [draftFileId, visibleFiles]);
  const unavailableReasonsRef = useRef<ReadonlyMap<string, string>>(unavailableReasons);
  unavailableReasonsRef.current = unavailableReasons;

  const availableSelections = useMemo(
    () => availableFileViewSelections(selections, unavailableReasons),
    [selections, unavailableReasons],
  );

  useEffect(() => {
    const viewKeys = new Set(views.map(registeredFileViewKey));
    const reviewedFileIds = [...fileIds];
    setSelections((current) => reconcileFileViewSelections(current, reviewedFileIds, viewKeys));
    setEpochs((current) => reconcileFileViewEpochs(current, reviewedFileIds, viewKeys));
  }, [fileIds, views]);

  /** Select raw or one registered presentation for a file. */
  const select = useCallback((fileId: string, viewKey: string | null) => {
    setSelections((current) => selectFileView(current, fileId, viewKey));
  }, []);

  /** Build invocation-time controls without capturing selection or registration state. */
  const createControls = useCallback(
    (extensionId: string): ExtensionFileViewControls => {
      const resolve = (viewId: string) =>
        resolveRegisteredFileView(viewsRef.current, extensionId, viewId);
      const selectView = (viewId: string | null) => {
        const fileId = getSelectedFileId();
        if (!fileId) {
          showNotice(`Extension ${extensionId} cannot select a file view without a selected file`);
          return;
        }
        const unavailableReason = unavailableReasonsRef.current.get(fileId);
        if (viewId !== null && unavailableReason) {
          showNotice(unavailableReason);
          return;
        }
        const registered = viewId === null ? undefined : resolve(viewId);
        if (viewId !== null && !registered) {
          showNotice(`Extension ${extensionId} targeted unknown file view "${viewId}"`);
          return;
        }
        if (registered) {
          const selected = getExtensionSelection().file;
          try {
            if (!selected || !registered.view.matches(selected)) {
              showNotice(`File view "${viewId}" does not match the selected file • using raw diff`);
              return;
            }
          } catch {
            showNotice(
              `Extension ${registered.extensionId} file view "${registered.view.id}" failed matching the selected file`,
            );
            return;
          }
        }
        select(fileId, registered ? registeredFileViewKey(registered) : null);
      };

      return {
        select: selectView,
        toggle(viewId: string) {
          const registered = resolve(viewId);
          const fileId = getSelectedFileId();
          if (fileId && unavailableReasonsRef.current.has(fileId)) {
            selectView(viewId);
            return;
          }
          if (
            fileId &&
            registered &&
            selectionsRef.current[fileId] === registeredFileViewKey(registered)
          ) {
            selectView(null);
          } else {
            selectView(viewId);
          }
        },
        isActive(viewId: string) {
          const registered = resolve(viewId);
          const fileId = getSelectedFileId();
          return Boolean(
            fileId &&
            !unavailableReasonsRef.current.has(fileId) &&
            registered &&
            selectionsRef.current[fileId] === registeredFileViewKey(registered),
          );
        },
        refresh(viewId: string, options?: { fileId?: string }) {
          const registered = resolve(viewId);
          if (!registered) {
            showNotice(`Extension ${extensionId} targeted unknown file view "${viewId}"`);
            return;
          }
          const fileId = typeof options?.fileId === "string" ? options.fileId : undefined;
          // A stale id can race a reload. It invalidates nothing and does not warn the extension.
          if (fileId !== undefined && !fileIdsRef.current.has(fileId)) return;
          setEpochs((current) =>
            bumpFileViewEpoch(current, registeredFileViewKey(registered), fileId),
          );
        },
      };
    },
    [getExtensionSelection, getSelectedFileId, select, showNotice],
  );

  const allFileViews = useMemo(() => toReadOnlyFileViews(files), [files]);
  const resolvedBulkTarget = useMemo(() => {
    if (!selectedFile || unavailableReasons.has(selectedFile.id)) return null;
    const key = selections[selectedFile.id];
    if (!key) return null;
    const registered = views.find((view) => registeredFileViewKey(view) === key);
    if (!registered) return null;

    const target = resolveBulkFileViewTarget({
      current: selections,
      files: allFileViews,
      registered,
      selectedFileId: selectedFile.id,
    });
    return target ? { ...target, title: registered.view.title } : null;
  }, [allFileViews, selections, selectedFile, unavailableReasons, views]);
  const bulkTarget = useMemo(
    () => (resolvedBulkTarget ? { title: resolvedBulkTarget.title } : null),
    [resolvedBulkTarget],
  );

  /** Apply the selected presentation to every matching file in the complete review. */
  const applyBulkTarget = useCallback(() => {
    if (!resolvedBulkTarget) return;
    setSelections((current) =>
      selectFileViewForFiles(current, resolvedBulkTarget.fileIds, resolvedBulkTarget.key),
    );
  }, [resolvedBulkTarget]);

  const menuEntries = useMemo(() => {
    if (!selectedFile) return [];
    const publicFile = getVisibleFileViews().find((file) => file.id === selectedFile.id);
    if (!publicFile) return [];
    const unavailableReason = unavailableReasons.get(selectedFile.id);
    const active = unavailableReason ? undefined : selections[selectedFile.id];
    const entries: MenuEntry[] = [
      {
        kind: "item",
        label: "File presentation: Raw diff",
        commandId: "hunk.view.filePresentation.raw",
        checked: active === undefined,
        action: () => select(selectedFile.id, null),
      },
    ];
    if (unavailableReason) return entries;

    for (const registered of views) {
      try {
        if (!registered.view.matches(publicFile)) continue;
      } catch {
        continue;
      }
      const key = registeredFileViewKey(registered);
      entries.push({
        kind: "item",
        label: `File presentation: ${registered.view.title}`,
        commandId: `hunk.view.filePresentation.${key}`,
        checked: active === key,
        action: () => select(selectedFile.id, key),
      });
    }
    return entries;
  }, [getVisibleFileViews, select, selectedFile, selections, unavailableReasons, views]);

  return {
    availableSelections,
    epochs,
    bulkTarget,
    menuEntries,
    createControls,
    applyBulkTarget,
  };
}
