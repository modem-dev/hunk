import { fileViewKey, qualifiedViewKey } from "../../extensions/apply";
import type { ExtensionDiffFile } from "../../extension-api/types";
import type { RegisteredFileView } from "../../extensions/types";
import {
  bumpScopedEpoch,
  reconcileScopedEpochs,
  scopedEpoch,
  type ScopedEpochState,
} from "../lib/scopedEpochs";

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

/** The registration one selection call resolved to, or why it cannot be shown. */
export type FileViewSelectionTarget =
  | { readonly ok: true; readonly registered: RegisteredFileView }
  | { readonly ok: false; readonly refusal: string };

/**
 * Decide whether one view can become the selected file's presentation.
 *
 * The single containment check behind `fileViews.select` and
 * `fileViews.enterMode`: an unknown id, a host constraint keeping the file on
 * raw diff, a view that does not claim the file, and a matcher that throws are
 * all reasons the view cannot be shown — and entering a mode now shows the view,
 * so both entry points must answer them identically rather than each deciding
 * for itself. The caller supplies the selected file and its unavailability
 * reason, so this stays a pure policy over what the host already computed.
 */
export function resolveFileViewSelectionTarget({
  extensionId,
  file,
  registered,
  unavailableReason,
  viewId,
}: {
  extensionId: string;
  file: ExtensionDiffFile;
  registered: RegisteredFileView | undefined;
  unavailableReason: string | undefined;
  viewId: string;
}): FileViewSelectionTarget {
  if (unavailableReason) {
    return { ok: false, refusal: unavailableReason };
  }

  if (!registered) {
    return {
      ok: false,
      refusal: `Extension ${extensionId} targeted unknown file view "${viewId}"`,
    };
  }

  try {
    if (!registered.view.matches(file)) {
      return {
        ok: false,
        refusal: `File view "${viewId}" does not match the selected file • using raw diff`,
      };
    }
  } catch {
    return {
      ok: false,
      refusal:
        `Extension ${registered.extensionId} file view "${registered.view.id}" ` +
        `failed matching the selected file`,
    };
  }

  return { ok: true, registered };
}

/**
 * Layout invalidation counters for one session.
 *
 * The shared scoped-epoch policy (`packages/hunk/src/ui/lib/scopedEpochs.ts`) keyed by
 * registered view, optionally narrowed to one reviewed file's presentation.
 */
export type FileViewEpochState = ScopedEpochState;

/** The invalidation epoch one `(file, view)` preparation is retained under. */
export function fileViewLayoutEpoch(epochs: FileViewEpochState, viewKey: string, fileId: string) {
  return scopedEpoch(epochs, viewKey, fileId);
}

/**
 * Invalidate prepared layouts by bumping one epoch.
 *
 * Without `fileId` this retires every prepared layout of the view; with one it
 * retires only that file's, leaving the other presenting files untouched.
 */
export function bumpFileViewEpoch(
  current: FileViewEpochState,
  viewKey: string,
  fileId?: string,
): FileViewEpochState {
  return bumpScopedEpoch(current, viewKey, fileId);
}

/**
 * Drop epochs a reload orphaned, keeping map identity when nothing changed.
 *
 * A scoped entry outlives neither its view nor the file it names: a reload that
 * drops either retires the entry with it.
 */
export function reconcileFileViewEpochs(
  current: FileViewEpochState,
  fileIds: readonly string[],
  viewKeys: ReadonlySet<string>,
): FileViewEpochState {
  return reconcileScopedEpochs(current, fileIds, viewKeys);
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
