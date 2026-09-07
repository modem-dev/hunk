/**
 * Coordinates file and hunk mutations, scoped discard/stash prompts, and stream tabs against the mounted review.
 * Sidebar paths survive tab changes; shared review navigation still owns the active diff.
 * AppHost tracks writes through shutdown and serializes their authoritative refreshes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppBootstrap } from "../../core/bootstrap";
import type { DiffFile } from "../../core/changeset/model";
import { reviewFileMatchesFilter } from "../../core/review/selectors";
import { getConfiguredVcsAdapter } from "../../core/vcs";
import { HunkUserError } from "../../core/run/errors";
import { summarizeHunk } from "../../core/changeset/hunkSummary";
import type {
  ExtensionVcsDiscardScope,
  ExtensionWorkingTreeFile,
  ExtensionWorkingTreePane,
} from "../../extension-api/types";
import type { ExtensionCapabilityLease } from "../lib/extensionCapabilityLease";
import type { WorkspaceWriteRunner } from "./useExtensionWorkspaceControls";
import {
  cursorFromSidebarIndex,
  filesVisuallyUnderSidebarEntry,
  nestedRevealPath,
  sidebarEntryIdAtIndex,
  sidebarIndexFromCursor,
  stepSidebarIndex,
  type FilePaneCursor,
} from "../lib/filePaneSelection";
import {
  buildFilePaneEntries,
  fileSidebarContentWidth,
  workingTreeSidebarSources,
  type SidebarFileSource,
} from "../lib/files";

/** Capture the exact files and generation the user is being asked to change. */
export interface WorkingTreePrompt {
  kind: "discard" | "stash";
  files: readonly ExtensionWorkingTreeFile[];
  label: string;
  folder: boolean;
  lease: ExtensionCapabilityLease;
}

/** Keep working-tree UI absent from historical, pager and non-provider reviews. */
export function hasWorkingTreeInventory(bootstrap: AppBootstrap) {
  return (
    bootstrap.input.kind === "vcs" &&
    bootstrap.input.range === undefined &&
    bootstrap.input.rangeEndpoints === undefined &&
    !bootstrap.input.options.pager &&
    bootstrap.changeset.workingTreeFiles !== undefined
  );
}

/** Expose generation-bound pane controls and command handlers for the current Git status inventory. */
export function useWorkingTreeActions({
  bootstrap,
  selectedFile,
  getSelection,
  isFilesPaneFocused,
  filter,
  reviewFiles,
  filesPaneFocused,
  filesPaneWidth,
  createLease,
  selectReviewFile,
  focusFiles,
  setStagedView,
  runMutation,
  refreshAfterMutation,
  showNotice,
}: {
  bootstrap: AppBootstrap;
  selectedFile: DiffFile | undefined;
  getSelection: () => { fileId: string | null; hunkIndex: number | null };
  isFilesPaneFocused: () => boolean;
  filter: string;
  reviewFiles: readonly SidebarFileSource[];
  filesPaneFocused: boolean;
  filesPaneWidth: number;
  createLease: () => ExtensionCapabilityLease;
  selectReviewFile: (fileId: string, options: { alignFileHeaderTop: true }) => void;
  focusFiles: () => void;
  setStagedView: (staged: boolean) => Promise<void>;
  runMutation: WorkspaceWriteRunner;
  refreshAfterMutation: (follow?: { root: string; staged: boolean }) => Promise<void>;
  showNotice: (message: string) => void;
}) {
  const enabled = hasWorkingTreeInventory(bootstrap);
  const staged = bootstrap.input.kind === "vcs" && bootstrap.input.staged;
  const allFiles = bootstrap.changeset.workingTreeFiles;
  const files = useMemo(
    () => (allFiles ?? []).filter((file) => reviewFileMatchesFilter(file, filter)),
    [allFiles, filter],
  );
  const operation =
    enabled && bootstrap.reloadContext.vcsCatalog
      ? getConfiguredVcsAdapter(bootstrap.input.options.vcs, bootstrap.reloadContext.vcsCatalog)
          .operations["working-tree-diff"]
      : undefined;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const switchingRef = useRef(false);
  const mutatingRef = useRef(false);
  const pendingCursorRef = useRef<{
    cursor: FilePaneCursor;
    changeset: AppBootstrap["changeset"];
  } | null>(null);
  const [chosenCursor, setChosenCursor] = useState<FilePaneCursor | null>(null);
  const sources = useMemo(
    () => (enabled ? workingTreeSidebarSources(reviewFiles, files) : []),
    [enabled, reviewFiles, files],
  );
  const entries = useMemo(
    () => buildFilePaneEntries(sources, fileSidebarContentWidth(filesPaneWidth)),
    [sources, filesPaneWidth],
  );
  const reviewFileCursor: FilePaneCursor | null = selectedFile
    ? { kind: "file", id: selectedFile.path }
    : null;
  const pendingCursor = pendingCursorRef.current?.cursor ?? null;
  const folderCursor = filesPaneFocused && chosenCursor?.kind === "folder" ? chosenCursor : null;
  const activeCursor = pendingCursor ?? folderCursor ?? reviewFileCursor ?? chosenCursor;
  const selectedIndex = sidebarIndexFromCursor(entries, activeCursor);
  const selectedEntryId = sidebarEntryIdAtIndex(entries, selectedIndex);
  // Rendered review selection remains authoritative between input batches; sidebar
  // handlers advance this cursor eagerly before a following mutation key can run.
  const activeCursorRef = useRef(activeCursor);
  activeCursorRef.current = activeCursor;
  const cursorReviewFileIdRef = useRef(selectedFile?.id ?? null);
  cursorReviewFileIdRef.current = selectedFile?.id ?? null;
  /** Derive rendered and input-time mutation targets from the same sidebar entry. */
  const selectionAt = (index: number) => {
    const statusFiles = filesVisuallyUnderSidebarEntry(entries, index)
      .map((entry) => files.find((file) => file.path === entry.id))
      .filter((file): file is ExtensionWorkingTreeFile => Boolean(file));
    const path = statusFiles[0]?.path ?? null;
    const entry = entries[index];
    const folder = Boolean(entry && entry.kind !== "file");
    return {
      statusFiles,
      path,
      folder,
      label: entry && entry.kind !== "file" ? entry.label : (path ?? ""),
    };
  };
  const {
    statusFiles: selectedStatusFiles,
    path: selectedPath,
    folder: selectedIsFolder,
  } = selectionAt(selectedIndex);
  /** Read the sidebar cursor after all preceding navigation in this input burst. */
  const liveCursor = () => {
    const { fileId } = getSelection();
    if (fileId !== cursorReviewFileIdRef.current) {
      const file = bootstrap.changeset.files.find((file) => file.id === fileId);
      activeCursorRef.current = file ? { kind: "file", id: file.path } : null;
      cursorReviewFileIdRef.current = fileId;
    }
    return activeCursorRef.current;
  };
  /** Derive mutation targets after both sidebar and review-stream navigation. */
  const liveSelection = () => selectionAt(sidebarIndexFromCursor(entries, liveCursor()));
  const lease = useMemo(() => createLease(), [bootstrap, createLease]);
  const [promptState, setPromptState] = useState<WorkingTreePrompt | null>(null);
  const promptRef = useRef<WorkingTreePrompt | null>(null);
  const [message, setMessageState] = useState("");
  const messageRef = useRef("");
  const cancelPrompt = useCallback(() => {
    promptRef.current = null;
    setPromptState(null);
  }, []);
  useEffect(() => {
    cancelPrompt();
  }, [bootstrap, cancelPrompt]);
  const getPrompt = useCallback(() => {
    const pending = promptRef.current;
    return pending?.lease.isLive() ? pending : null;
  }, []);
  const setMessage = useCallback((value: string) => {
    messageRef.current = value;
    setMessageState(value);
  }, []);

  useEffect(() => {
    const pending = pendingCursorRef.current;
    if (!pending || pending.changeset === bootstrap.changeset) return;
    // Consume a follow request once its authoritative inventory arrives, including clean files.
    pendingCursorRef.current = null;
    setChosenCursor(pending.cursor);
    const index = sidebarIndexFromCursor(entries, pending.cursor);
    const followPath =
      filesVisuallyUnderSidebarEntry(entries, index)[0]?.id ??
      (pending.cursor.kind === "file" ? pending.cursor.id : null);
    const file = followPath
      ? bootstrap.changeset.files.find((candidate) => candidate.path === followPath)
      : undefined;
    if (file) selectReviewFile(file.id, { alignFileHeaderTop: true });
  }, [bootstrap, entries, selectReviewFile]);

  /** Switch the full stream without letting fast repeated keys enqueue stale switches. */
  const switchView = useCallback(
    async (next: boolean) => {
      if (!enabled || !lease.isLive() || busyRef.current || next === staged) return;
      busyRef.current = true;
      switchingRef.current = true;
      setBusy(true);
      try {
        await setStagedView(next);
      } catch (error) {
        pendingCursorRef.current = null;
        showNotice(
          `Could not switch review: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        switchingRef.current = false;
        busyRef.current = mutatingRef.current;
        setBusy(busyRef.current);
      }
    },
    [enabled, lease, staged, setStagedView, showNotice],
  );

  const revealStatusPath = useCallback(
    (path: string, cursor: FilePaneCursor) => {
      if (!lease.isLive() || busyRef.current) return;
      const status = files.find((file) => file.path === path);
      if (!status) return;
      focusFiles();
      activeCursorRef.current = cursor;
      pendingCursorRef.current = null;
      setChosenCursor(cursor);
      // A recreated rename source is a separate status row, never an alias for the destination.
      const file = (staged ? status.staged : status.unstaged)
        ? bootstrap.changeset.files.find((candidate) => candidate.path === path)
        : undefined;
      if (file) {
        selectReviewFile(file.id, { alignFileHeaderTop: true });
        cursorReviewFileIdRef.current = getSelection().fileId;
        return;
      }
      pendingCursorRef.current = { cursor, changeset: bootstrap.changeset };
      void switchView(!staged);
    },
    [
      lease,
      files,
      focusFiles,
      bootstrap.changeset,
      selectReviewFile,
      getSelection,
      switchView,
      staged,
    ],
  );

  const selectFile = useCallback(
    (path: string) => {
      revealStatusPath(path, { kind: "file", id: path });
    },
    [revealStatusPath],
  );

  const selectEntry = useCallback(
    (id: string) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      const cursor = cursorFromSidebarIndex(entries, index);
      if (!cursor) return;
      const nested = filesVisuallyUnderSidebarEntry(entries, index);
      const currentSidePaths = new Set(
        files.filter((file) => (staged ? file.staged : file.unstaged)).map((file) => file.path),
      );
      const revealPath = nestedRevealPath(nested, currentSidePaths);
      if (revealPath) revealStatusPath(revealPath, cursor);
      else {
        focusFiles();
        activeCursorRef.current = cursor;
        setChosenCursor(cursor);
      }
    },
    [entries, files, focusFiles, revealStatusPath, staged],
  );

  const canToggleFile = useCallback(
    (file: ExtensionWorkingTreeFile | undefined) =>
      Boolean(
        file &&
        !file.unavailableReason &&
        !file.conflicted &&
        (file.unstaged ? operation?.stageFile : file.staged && operation?.unstageFile),
      ),
    [operation],
  );

  const stagingTargets = useCallback(
    (targets: readonly ExtensionWorkingTreeFile[]) => {
      const actionable = targets.filter(canToggleFile);
      const toStage = actionable.filter((file) => file.unstaged);
      if (toStage.length > 0) return { stage: true, files: toStage };
      return { stage: false, files: actionable.filter((file) => file.staged) };
    },
    [canToggleFile],
  );

  /** Keep file and hunk writes on the same busy, error, refresh, and graceful-exit path. */
  const startMutation = useCallback(
    (action: {
      mutate: () => Promise<void>;
      progress: string;
      complete: string;
      followStaged?: boolean;
      followCursor?: FilePaneCursor | null;
    }) => {
      busyRef.current = true;
      mutatingRef.current = true;
      setBusy(true);
      showNotice(action.progress);
      void runMutation(async () => {
        let succeeded = false;
        try {
          await action.mutate();
          succeeded = true;
          if (action.followStaged !== undefined && action.followCursor)
            pendingCursorRef.current = {
              cursor: action.followCursor,
              changeset: bootstrap.changeset,
            };
        } finally {
          // A failed provider command can partially change state, so reconcile before unlocking.
          await refreshAfterMutation(
            succeeded && action.followStaged !== undefined
              ? { root: bootstrap.changeset.sourceLabel, staged: action.followStaged }
              : undefined,
          );
        }
      })
        .then((started) =>
          showNotice(
            started
              ? action.complete
              : "Another workspace operation is active or Hunk is shutting down.",
          ),
        )
        .catch((error) => {
          const detail =
            error instanceof HunkUserError
              ? [error.message, ...error.suggestions].join(" • ")
              : error instanceof Error
                ? error.message
                : String(error);
          showNotice(`Git action failed: ${detail}`);
        })
        .finally(() => {
          mutatingRef.current = false;
          busyRef.current = switchingRef.current;
          setBusy(busyRef.current);
        });
    },
    [bootstrap.changeset, runMutation, refreshAfterMutation, showNotice],
  );

  const describeTargets = (targets: readonly ExtensionWorkingTreeFile[], label: string) =>
    targets.length === 1 ? targets[0]!.path : `${targets.length} files in ${label}`;

  const toggleStatusFiles = useCallback(
    (
      targets: readonly ExtensionWorkingTreeFile[],
      cursor: FilePaneCursor | null,
      label: string,
    ) => {
      if (!lease.isLive() || mutatingRef.current || bootstrap.input.kind !== "vcs") return;
      const { stage, files: next } = stagingTargets(targets);
      if (next.length === 0) return;
      const mutate = stage ? operation?.stageFile : operation?.unstageFile;
      if (!mutate) return;
      const input = bootstrap.input;
      const context = { cwd: bootstrap.changeset.sourceLabel };
      const subject = describeTargets(next, label);
      startMutation({
        mutate: async () => {
          for (const file of next) await mutate(input, file, context);
        },
        progress: `${stage ? "Staging" : "Unstaging"} ${subject}…`,
        complete: `${stage ? "Staged" : "Unstaged"} ${subject}.`,
        followStaged: stage,
        followCursor: cursor,
      });
    },
    [lease, bootstrap, operation, stagingTargets, startMutation],
  );

  const toggleStaged = useCallback(
    (path: string) => {
      // A double-click may finish while its first click switches tabs; its explicit path is attested.
      const file = files.find((candidate) => candidate.path === path);
      if (!file || !canToggleFile(file)) return;
      toggleStatusFiles([file], { kind: "file", id: path }, file.path);
    },
    [files, canToggleFile, toggleStatusFiles],
  );

  const toggleEntry = useCallback(
    (id: string) => {
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      const cursor = cursorFromSidebarIndex(entries, index);
      const nested = filesVisuallyUnderSidebarEntry(entries, index)
        .map((entry) => files.find((file) => file.path === entry.id))
        .filter((file): file is ExtensionWorkingTreeFile => Boolean(file));
      const label =
        entries[index] && entries[index]!.kind !== "file"
          ? entries[index]!.label
          : (nested[0]?.path ?? id);
      toggleStatusFiles(nested, cursor, label);
    },
    [entries, files, toggleStatusFiles],
  );

  const canToggleHunk = useCallback(
    (fileId: string | undefined, hunkIndex: number) => {
      if (!lease.isLive() || busyRef.current) return false;
      const reviewed = bootstrap.changeset.files.find((file) => file.id === fileId);
      const status = files.find((file) => file.path === reviewed?.path);
      return Boolean(
        reviewed?.metadata.hunks[hunkIndex] &&
        !reviewed.isBinary &&
        !reviewed.isTooLarge &&
        status &&
        !status.unavailableReason &&
        !status.conflicted &&
        (staged
          ? status.staged && operation?.unstageHunk
          : status.unstaged && operation?.stageHunk),
      );
    },
    [bootstrap.changeset.files, files, staged, operation, lease],
  );

  const toggleHunk = useCallback(
    (fileId: string, hunkIndex: number) => {
      if (!canToggleHunk(fileId, hunkIndex) || bootstrap.input.kind !== "vcs") return false;
      const reviewed = bootstrap.changeset.files.find((file) => file.id === fileId)!;
      const file = files.find((file) => file.path === reviewed.path)!;
      const mutate = staged ? operation?.unstageHunk : operation?.stageHunk;
      if (!mutate) return false;
      const input = bootstrap.input;
      const hunk = summarizeHunk(reviewed.metadata.hunks[hunkIndex]!, hunkIndex);
      startMutation({
        mutate: () => mutate(input, file, hunk, { cwd: bootstrap.changeset.sourceLabel }),
        progress: `${staged ? "Unstaging" : "Staging"} hunk ${hunkIndex + 1} in ${file.path}…`,
        complete: `${staged ? "Unstaged" : "Staged"} hunk ${hunkIndex + 1} in ${file.path}.`,
      });
      return true;
    },
    [canToggleHunk, bootstrap, files, operation, staged, startMutation],
  );

  /** Resolve prompt eligibility from the cursor reached by the latest input event. */
  const promptSelection = () => {
    const selection = liveSelection();
    const actionableFiles = selection.statusFiles.filter(
      (file) => !file.conflicted && !file.unavailableReason,
    );
    return {
      ...selection,
      actionableFiles,
      canDiscard: Boolean(enabled && actionableFiles.length > 0 && operation?.discardFile),
      canStash: Boolean(
        enabled &&
        actionableFiles.length > 0 &&
        (actionableFiles.length === 1
          ? operation?.stashFile || operation?.stashFiles
          : operation?.stashFiles),
      ),
    };
  };

  /** Open a generation-bound prompt; rapid repeated keys cannot replace its captured target. */
  const openPrompt = (kind: WorkingTreePrompt["kind"]) => {
    const selection = promptSelection();
    const { actionableFiles } = selection;
    if (
      !lease.isLive() ||
      busyRef.current ||
      getPrompt() ||
      actionableFiles.length === 0 ||
      !(kind === "discard" ? selection.canDiscard : selection.canStash)
    )
      return;
    const pending = {
      kind,
      files: actionableFiles,
      label: selection.label || actionableFiles[0]!.path,
      folder: selection.folder,
      lease,
    };
    setMessage("");
    promptRef.current = pending;
    setPromptState(pending);
  };

  /** Accept the shown scope once, retaining the shared mutation and authoritative refresh lifecycle. */
  const acceptPrompt = (scope: ExtensionVcsDiscardScope = "all") => {
    const pending = getPrompt();
    if (!pending || busyRef.current || bootstrap.input.kind !== "vcs") return;
    const { files: targets, kind, label } = pending;
    if (
      kind === "discard" &&
      scope === "unstaged" &&
      !targets.some((file) => file.staged && file.unstaged)
    )
      return;
    const input = bootstrap.input;
    const context = { cwd: bootstrap.changeset.sourceLabel };
    const discard = operation?.discardFile;
    const stashOne = operation?.stashFile;
    const stashMany = operation?.stashFiles;
    if (kind === "discard" ? !discard : !(stashMany || stashOne)) return;
    const stashMessage = messageRef.current;
    const subject = describeTargets(targets, label);
    cancelPrompt();
    startMutation({
      mutate: async () => {
        if (kind === "discard") {
          for (const file of targets) {
            if (scope === "unstaged") {
              if (file.staged && file.unstaged) await discard!(input, file, "unstaged", context);
              else if (file.unstaged && !file.staged && !file.untracked)
                await discard!(input, file, "all", context);
              continue;
            }
            await discard!(input, file, scope, context);
          }
          return;
        }
        if (stashOne && targets.length === 1) {
          await stashOne(input, targets[0]!, stashMessage, context);
          return;
        }
        await stashMany!(input, targets, stashMessage, context);
      },
      progress: `${kind === "discard" ? "Discarding" : "Stashing"} ${subject}…`,
      complete:
        kind === "discard" ? `Discarded ${scope} changes in ${subject}.` : `Stashed ${subject}.`,
    });
  };

  const pane = useMemo<ExtensionWorkingTreePane | undefined>(
    () =>
      enabled
        ? Object.freeze({
            files,
            selectedPath,
            selectedEntryId,
            staged,
            busy,
            selectFile,
            selectEntry,
            toggleStaged,
            toggleEntry,
          })
        : undefined,
    [
      enabled,
      files,
      selectedPath,
      selectedEntryId,
      staged,
      busy,
      selectFile,
      selectEntry,
      toggleStaged,
      toggleEntry,
    ],
  );

  const selectedToggle = stagingTargets(
    filesPaneFocused
      ? selectedStatusFiles
      : selectedPath
        ? files.filter((file) => file.path === selectedPath)
        : [],
  );
  /** Read file staging targets from the latest pane focus and semantic selection. */
  const liveStagingFiles = () => {
    if (isFilesPaneFocused()) return liveSelection().statusFiles;
    const { fileId } = getSelection();
    const reviewed = bootstrap.changeset.files.find((file) => file.id === fileId);
    return files.filter((file) => file.path === reviewed?.path);
  };

  return {
    prompt: promptState?.lease.isLive() ? promptState : null,
    getPrompt,
    cancelPrompt,
    acceptPrompt,
    message,
    setMessage,
    get canDiscardSelected() {
      return promptSelection().canDiscard;
    },
    get canStashSelected() {
      return promptSelection().canStash;
    },
    discardSelected: () => openPrompt("discard"),
    stashSelected: () => openPrompt("stash"),
    pane,
    busy,
    staged,
    selectedPath,
    selectedIsFolder: Boolean(filesPaneFocused && selectedIsFolder),
    isSelectedFolder: () => liveSelection().folder,
    selectedWillStage: selectedToggle.stage,
    get canToggleSelected() {
      return enabled && stagingTargets(liveStagingFiles()).files.length > 0;
    },
    get canToggleSelectedHunk() {
      const { fileId, hunkIndex } = getSelection();
      return enabled && hunkIndex !== null && canToggleHunk(fileId ?? undefined, hunkIndex);
    },
    canToggleHunk,
    toggleHunk,
    toggleSelectedHunk: () => {
      const { fileId, hunkIndex } = getSelection();
      if (fileId && hunkIndex !== null) toggleHunk(fileId, hunkIndex);
    },
    toggleSelected: () => {
      if (busyRef.current) return;
      if (isFilesPaneFocused()) {
        const entryId = sidebarEntryIdAtIndex(
          entries,
          sidebarIndexFromCursor(entries, liveCursor()),
        );
        if (entryId) toggleEntry(entryId);
        return;
      }
      const file = liveStagingFiles()[0];
      if (file) toggleStaged(file.path);
    },
    switchView: (next: boolean) => {
      void switchView(next);
    },
    moveFile: (delta: number) => {
      const selectedPath = liveSelection().path;
      const index = files.findIndex((file) => file.path === selectedPath);
      const file = files[Math.max(0, Math.min(files.length - 1, index + delta))];
      if (file && file.path !== selectedPath) selectFile(file.path);
    },
    moveEntry: (delta: number) => {
      const selectedIndex = sidebarIndexFromCursor(entries, liveCursor());
      const nextIndex = stepSidebarIndex(entries, selectedIndex, delta);
      const next = entries[nextIndex];
      if (next && next.id !== sidebarEntryIdAtIndex(entries, selectedIndex)) selectEntry(next.id);
    },
  };
}
