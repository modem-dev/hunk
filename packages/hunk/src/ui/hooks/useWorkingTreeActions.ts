/**
 * Coordinates file staging and staged/unstaged stream tabs against the mounted review.
 * Sidebar paths survive tab changes; shared review navigation still owns the active diff.
 * AppHost tracks writes through shutdown and serializes their authoritative refreshes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppBootstrap } from "../../core/bootstrap";
import type { DiffFile } from "../../core/changeset/model";
import { reviewFileMatchesFilter } from "../../core/review/selectors";
import { getConfiguredVcsAdapter } from "../../core/vcs";
import { HunkUserError } from "../../core/run/errors";
import type { ExtensionWorkingTreePane } from "../../extension-api/types";
import type { ExtensionCapabilityLease } from "../lib/extensionCapabilityLease";
import type { WorkspaceWriteRunner } from "./useExtensionWorkspaceControls";

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
  filter,
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
  filter: string;
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
  const pendingPathRef = useRef<{ path: string; changeset: AppBootstrap["changeset"] } | null>(
    null,
  );
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const selectedPath =
    [pendingPathRef.current?.path, selectedFile?.path, chosenPath].find((path) =>
      files.some((file) => file.path === path),
    ) ??
    files[0]?.path ??
    null;
  const lease = useMemo(() => createLease(), [bootstrap, createLease]);

  useEffect(() => {
    const pending = pendingPathRef.current;
    if (!pending || pending.changeset === bootstrap.changeset) return;
    // Consume a follow request once its authoritative inventory arrives, including clean files.
    pendingPathRef.current = null;
    const file = bootstrap.changeset.files.find((candidate) => candidate.path === pending.path);
    setChosenPath(file?.path ?? null);
    if (file) selectReviewFile(file.id, { alignFileHeaderTop: true });
  }, [bootstrap, selectReviewFile]);

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
        pendingPathRef.current = null;
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

  const selectFile = useCallback(
    (path: string) => {
      if (!lease.isLive() || busyRef.current) return;
      const status = files.find((file) => file.path === path);
      if (!status) return;
      focusFiles();
      pendingPathRef.current = null;
      setChosenPath(path);
      // A recreated rename source is a separate status row, never an alias for the destination.
      const file = (staged ? status.staged : status.unstaged)
        ? bootstrap.changeset.files.find((candidate) => candidate.path === path)
        : undefined;
      if (file) {
        selectReviewFile(file.id, { alignFileHeaderTop: true });
        return;
      }
      pendingPathRef.current = { path, changeset: bootstrap.changeset };
      void switchView(!staged);
    },
    [lease, files, focusFiles, bootstrap.changeset, selectReviewFile, switchView, staged],
  );

  const canToggle = useCallback(
    (path: string | null) => {
      const file = files.find((candidate) => candidate.path === path);
      return Boolean(
        file &&
        !file.unavailableReason &&
        !file.conflicted &&
        (file.unstaged ? operation?.stageFile : file.staged && operation?.unstageFile),
      );
    },
    [files, operation],
  );

  const toggleStaged = useCallback(
    (path: string) => {
      // A file double-click may arrive while its first click is switching tabs. The path is
      // explicit and attested, so let that gesture finish; keyboard repeats remain blocked.
      if (
        !lease.isLive() ||
        mutatingRef.current ||
        !canToggle(path) ||
        bootstrap.input.kind !== "vcs"
      )
        return;
      const file = files.find((candidate) => candidate.path === path)!;
      const mutate = file.unstaged ? operation?.stageFile : operation?.unstageFile;
      if (!mutate) return;
      const input = bootstrap.input;
      busyRef.current = true;
      mutatingRef.current = true;
      setBusy(true);
      showNotice(`${file.unstaged ? "Staging" : "Unstaging"} ${file.path}…`);
      void runMutation(async () => {
        let succeeded = false;
        try {
          await mutate(input, file, { cwd: bootstrap.changeset.sourceLabel });
          succeeded = true;
          pendingPathRef.current = { path: file.path, changeset: bootstrap.changeset };
        } finally {
          // A failed Git command may still have changed state. Always reconcile before unlocking.
          await refreshAfterMutation(
            succeeded
              ? { root: bootstrap.changeset.sourceLabel, staged: file.unstaged }
              : undefined,
          );
        }
      })
        .then((started) => {
          showNotice(
            started
              ? `${file.unstaged ? "Staged" : "Unstaged"} ${file.path}.`
              : "Another workspace operation is active or Hunk is shutting down.",
          );
        })
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
    [lease, canToggle, bootstrap, files, operation, runMutation, refreshAfterMutation, showNotice],
  );

  const pane = useMemo<ExtensionWorkingTreePane | undefined>(
    () =>
      enabled
        ? Object.freeze({
            files,
            selectedPath,
            staged,
            busy,
            selectFile,
            toggleStaged,
          })
        : undefined,
    [enabled, files, selectedPath, staged, busy, selectFile, toggleStaged],
  );

  return {
    pane,
    busy,
    staged,
    selectedPath,
    canToggleSelected: enabled && canToggle(selectedPath),
    toggleSelected: () => {
      if (!busyRef.current && selectedPath) toggleStaged(selectedPath);
    },
    switchView: (next: boolean) => {
      void switchView(next);
    },
    moveFile: (delta: number) => {
      const index = files.findIndex((file) => file.path === selectedPath);
      const file = files[Math.max(0, Math.min(files.length - 1, index + delta))];
      if (file && file.path !== selectedPath) selectFile(file.path);
    },
  };
}
