import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile } from "../../core/changeset/model";
import type {
  ExtensionContext,
  ExtensionDiffFile,
  ExtensionFileViewMode,
  ExtensionFileViewModeContext,
  ExtensionFileViewModeKeyResult,
  ExtensionKeyEvent,
  ExtensionReviewSelection,
} from "../../extension-api/types";
import { toReadOnlyFileViews } from "../../extensions/events";
import type { ExtensionFileViewControls, RegisteredFileView } from "../../extensions/types";
import type { MenuEntry } from "../components/chrome/menu";
import {
  availableFileViewSelections,
  fileViewUnavailableReason,
  presentedFileViewKey,
} from "./availability";
import {
  deliverFileViewModeKey,
  fileViewModeStatusHint,
  fileViewModeStillValid,
  resolveFileViewModeActivation,
  runFileViewModeLifecycle,
  type ActiveFileViewMode,
} from "./mode";
import {
  bumpFileViewEpoch,
  reconcileFileViewEpochs,
  reconcileFileViewSelections,
  registeredFileViewKey,
  resolveBulkFileViewTarget,
  resolveFileViewSelectionTarget,
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
  /** Whether one extension file-view mode owns non-modal keys right now. */
  isModeActive: () => boolean;
  /** Lowest-precedence status text for the active mode. */
  modeStatusHint: string | null;
  /** Leave the active mode and run its teardown exactly once. */
  exitMode: () => void;
  /** Offer a key to the active mode. */
  sendModeKey: (key: ExtensionKeyEvent) => ExtensionFileViewModeKeyResult;
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
  cwd,
  notify,
  reviewGeneration,
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
  /** Host context exposed to mode lifecycle and key handlers. */
  cwd: string;
  notify: ExtensionContext["notify"];
  /** Identity token changed whenever a reload replaces the review. */
  reviewGeneration: unknown;
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

  const reviewGenerationRef = useRef(reviewGeneration);
  reviewGenerationRef.current = reviewGeneration;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  // One mode may own non-modal keys app-wide. The ref updates eagerly so a second key in the same
  // input flush sees entry or exit immediately; state exists to repaint the status hint.
  const [activeMode, setActiveModeState] = useState<ActiveFileViewMode | null>(null);
  const activeModeRef = useRef<ActiveFileViewMode | null>(null);
  const setActiveMode = useCallback((next: ActiveFileViewMode | null) => {
    activeModeRef.current = next;
    setActiveModeState(next);
  }, []);
  const warnMode = useCallback((message: string) => notifyRef.current(message, "warning"), []);

  /** Leave the active mode, running its teardown exactly once. */
  const exitMode = useCallback(() => {
    const active = activeModeRef.current;
    if (!active) return;
    setActiveMode(null);
    runFileViewModeLifecycle(active, "onExit", warnMode);
  }, [setActiveMode, warnMode]);
  const exitModeRef = useRef(exitMode);
  exitModeRef.current = exitMode;
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      // Async command handlers may outlive a hard App remount. Mark their controls dead before
      // teardown so a resumed handler cannot start an orphaned mode in this unmounted controller.
      aliveRef.current = false;
      exitModeRef.current();
    },
    [],
  );

  /** Report live ownership between keys delivered in the same input flush. */
  const isModeActive = useCallback(() => activeModeRef.current !== null, []);

  /** Offer one key to the active mode without capturing a stale activation. */
  const sendModeKey = useCallback(
    (key: ExtensionKeyEvent): ExtensionFileViewModeKeyResult => {
      const active = activeModeRef.current;
      if (!active) return "pass";
      const result = deliverFileViewModeKey(active, key, warnMode);
      // A handler may hand off to another mode through its own controls. An `exit` result belongs
      // to the mode that produced it, so keyboard routing must not tear down its replacement.
      return result === "exit" && activeModeRef.current !== active ? "handled" : result;
    },
    [warnMode],
  );

  const createControlsRef = useRef<(extensionId: string) => ExtensionFileViewControls>(() => {
    throw new Error("File presentation controls are not ready");
  });

  /** Start one resolved mode with a snapshot of the review it acts on. */
  const beginMode = useCallback(
    (callerId: string, registered: RegisteredFileView, mode: ExtensionFileViewMode) => {
      if (!aliveRef.current) {
        showNotice(`Extension ${callerId} cannot enter a mode after its review session closed`);
        return false;
      }
      const file = getExtensionSelection().file;
      if (!file) {
        showNotice(`Extension ${callerId} cannot enter a mode without a selected file`);
        return false;
      }

      // A successful handoff always tears the previous mode down before the new mode enters. If
      // its onExit deliberately enters another mode, that re-entrant activation wins rather than
      // being overwritten without receiving its own teardown.
      exitMode();
      if (activeModeRef.current) return false;
      const ownerId = registered.extensionId;
      const ctx: ExtensionFileViewModeContext = {
        cwd: cwdRef.current,
        notify: (...args) => notifyRef.current(...args),
        file,
        fileViews: createControlsRef.current(ownerId),
      };
      const active: ActiveFileViewMode = {
        ctx,
        extensionId: ownerId,
        fileId: file.id,
        mode,
        registered,
        reviewGeneration: reviewGenerationRef.current,
        viewId: registered.view.id,
        viewKey: registeredFileViewKey(registered),
      };
      setActiveMode(active);
      if (!runFileViewModeLifecycle(active, "onEnter", warnMode)) {
        // onEnter may itself hand off through ctx.fileViews. Only tear down the activation that
        // actually failed; its replacement owns an independent lifecycle.
        if (activeModeRef.current === active) exitMode();
        return false;
      }
      return true;
    },
    [exitMode, getExtensionSelection, setActiveMode, showNotice, warnMode],
  );

  /** Build invocation-time controls without capturing selection or registration state. */
  const createControls = useCallback(
    (extensionId: string): ExtensionFileViewControls => {
      const resolve = (viewId: string) =>
        resolveRegisteredFileView(viewsRef.current, extensionId, viewId);
      const presentedKey = () =>
        presentedFileViewKey(
          selectionsRef.current,
          unavailableReasonsRef.current,
          getSelectedFileId(),
        );
      const selectView = (viewId: string | null) => {
        const fileId = getSelectedFileId();
        if (!fileId) {
          showNotice(`Extension ${extensionId} cannot select a file view without a selected file`);
          return;
        }
        if (viewId === null) {
          select(fileId, null);
          return;
        }
        const unavailableReason = unavailableReasonsRef.current.get(fileId);
        if (unavailableReason) {
          showNotice(unavailableReason);
          return;
        }
        const registered = resolve(viewId);
        if (!registered) {
          showNotice(`Extension ${extensionId} targeted unknown file view "${viewId}"`);
          return;
        }
        const file = getExtensionSelection().file;
        if (!file) {
          showNotice(`File view "${viewId}" does not match the selected file • using raw diff`);
          return;
        }
        const target = resolveFileViewSelectionTarget({
          extensionId,
          file,
          registered,
          unavailableReason: undefined,
          viewId,
        });
        if (!target.ok) {
          showNotice(target.refusal);
          return;
        }
        select(fileId, registeredFileViewKey(target.registered));
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
          if (registered && presentedKey() === registeredFileViewKey(registered)) {
            selectView(null);
          } else {
            selectView(viewId);
          }
        },
        isActive(viewId: string) {
          const registered = resolve(viewId);
          return Boolean(registered && presentedKey() === registeredFileViewKey(registered));
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
        enterMode(viewId: string) {
          if (!aliveRef.current) {
            showNotice(
              `Extension ${extensionId} cannot enter a mode after its review session closed`,
            );
            return false;
          }
          const file = getExtensionSelection().file;
          const activation = resolveFileViewModeActivation({
            activeViewKey: presentedKey(),
            extensionId,
            file,
            registered: resolve(viewId),
            unavailableReason: file ? unavailableReasonsRef.current.get(file.id) : undefined,
            viewId,
          });
          if (!activation.ok) {
            showNotice(activation.refusal);
            return false;
          }
          if (activation.select) {
            select(activation.select.fileId, activation.select.viewKey);
          }
          return beginMode(extensionId, activation.registered, activation.mode);
        },
        exitMode,
        isModeActive(viewId: string) {
          const registered = resolve(viewId);
          const active = activeModeRef.current;
          return Boolean(
            registered && active && active.viewKey === registeredFileViewKey(registered),
          );
        },
      };
    },
    [beginMode, exitMode, getExtensionSelection, getSelectedFileId, select, showNotice],
  );
  createControlsRef.current = createControls;

  const presentedKeyForSelectedFile = presentedFileViewKey(
    selections,
    unavailableReasons,
    selectedFile?.id ?? null,
  );
  useEffect(() => {
    if (
      !activeMode ||
      fileViewModeStillValid(activeMode, {
        activeViewKey: presentedKeyForSelectedFile,
        reviewGeneration,
        selectedFileId: selectedFile?.id ?? null,
        views,
      })
    ) {
      return;
    }
    exitMode();
  }, [
    activeMode,
    exitMode,
    presentedKeyForSelectedFile,
    reviewGeneration,
    selectedFile?.id,
    views,
  ]);

  const modeStatusHint = activeMode ? fileViewModeStatusHint(activeMode) : null;

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
    isModeActive,
    modeStatusHint,
    exitMode,
    sendModeKey,
    applyBulkTarget,
  };
}
