import { fileViewKey, qualifiedViewKey } from "../../extensions/apply";
import type { ExtensionDiffFile } from "../../extension-api/types";
import type { RegisteredFileView } from "../../extensions/types";

/** Raw is implicit: only files explicitly switched away from raw have an entry. */
export type FileViewSelectionState = Readonly<Record<string, string>>;

/** Resolve one registered view key as `<extensionId>:<viewId>`. */
export function registeredFileViewKey(view: RegisteredFileView) {
  // Selection lookup and duplicate resolution must agree, so both derive the key from one policy.
  return fileViewKey(view);
}

/** Resolve a bare local or qualified file-view id without reserving extension ids. */
export function resolveRegisteredFileView(
  views: readonly RegisteredFileView[],
  extensionId: string,
  viewId: string,
) {
  const key = viewId.includes(":") ? viewId : qualifiedViewKey(extensionId, viewId);
  return views.find((view) => registeredFileViewKey(view) === key);
}

/**
 * Per-view layout invalidation counters, keyed like `registeredFileViewKey`.
 *
 * Absent means zero: a view only earns an entry once something invalidates it,
 * so the common session never carries any epoch state at all.
 */
export type FileViewEpochState = ReadonlyMap<string, number>;

/** Invalidate one view's prepared layouts by bumping its epoch. */
export function bumpFileViewEpoch(
  current: FileViewEpochState,
  viewKey: string,
): FileViewEpochState {
  // A fresh map identity is the signal preparation watches; mutating in place would be invisible.
  const next = new Map(current);
  next.set(viewKey, (current.get(viewKey) ?? 0) + 1);
  return next;
}

/** Drop epochs for views a reload removed, keeping map identity when nothing changed. */
export function reconcileFileViewEpochs(
  current: FileViewEpochState,
  viewKeys: ReadonlySet<string>,
): FileViewEpochState {
  if (current.size === 0) return current;
  const next = new Map<string, number>();
  for (const [viewKey, epoch] of current) {
    if (viewKeys.has(viewKey)) next.set(viewKey, epoch);
  }
  return next.size === current.size ? current : next;
}

/** Reconcile per-file selections after filtering/reload removes files or views. */
export function reconcileFileViewSelections(
  current: FileViewSelectionState,
  fileIds: readonly string[],
  viewKeys: ReadonlySet<string>,
): FileViewSelectionState {
  const validFileIds = new Set(fileIds);
  const next: Record<string, string> = {};
  let changed = false;
  for (const [fileId, viewKey] of Object.entries(current)) {
    if (validFileIds.has(fileId) && viewKeys.has(viewKey)) {
      next[fileId] = viewKey;
    } else {
      changed = true;
    }
  }
  return changed ? next : current;
}

/** Select raw or a named view for one file without retaining a redundant raw entry. */
export function selectFileView(
  current: FileViewSelectionState,
  fileId: string,
  viewKey: string | null,
): FileViewSelectionState {
  if (viewKey === null) {
    if (!(fileId in current)) return current;
    const { [fileId]: _removed, ...next } = current;
    return next;
  }
  if (current[fileId] === viewKey) return current;
  return { ...current, [fileId]: viewKey };
}

export interface BulkFileViewTarget {
  readonly key: string;
  readonly fileIds: readonly string[];
}

/** Resolve the changeset-wide matching set only while the selected file still uses and matches it. */
export function resolveBulkFileViewTarget({
  current,
  files,
  registered,
  selectedFileId,
}: {
  current: FileViewSelectionState;
  files: readonly ExtensionDiffFile[];
  registered: RegisteredFileView;
  selectedFileId: string;
}): BulkFileViewTarget | null {
  const key = registeredFileViewKey(registered);
  if (current[selectedFileId] !== key) return null;
  const fileIds: string[] = [];
  for (const file of files) {
    try {
      if (registered.view.matches(file)) fileIds.push(file.id);
    } catch {
      // One cooperative matcher failure excludes only that file from the host-owned batch.
    }
  }
  if (!fileIds.includes(selectedFileId)) return null;
  return fileIds.some((fileId) => current[fileId] !== key) ? { key, fileIds } : null;
}

/** Apply one presentation to a host-resolved set of matching files without touching nonmatches. */
export function selectFileViewForFiles(
  current: FileViewSelectionState,
  fileIds: readonly string[],
  viewKey: string,
): FileViewSelectionState {
  if (fileIds.every((fileId) => current[fileId] === viewKey)) return current;
  const next = { ...current };
  for (const fileId of fileIds) next[fileId] = viewKey;
  return next;
}
