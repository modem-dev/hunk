import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile } from "../../core/changeset/model";
import type { RegisteredFileView } from "../../extensions/types";
import {
  fileViewHunkCount,
  createFileViewInput,
  createFileViewInputSnapshot,
  type FileViewInputSnapshot,
} from "./host";
import {
  validateFileViewLayout,
  validateFileViewSourceRanges,
  type ValidatedFileViewLayout,
} from "./layout";
import { fileViewLayoutEpoch, registeredFileViewKey, type FileViewEpochState } from "./state";

/** Bound asynchronous third-party layout work so raw diff never waits indefinitely. */
export const FILE_VIEW_LAYOUT_TIMEOUT_MS = 1_500;
/** Keep extension preparation parallel but bounded across a large changeset. */
export const FILE_VIEW_LAYOUT_CONCURRENCY = 4;
/** Coalesce rapid width changes without ever painting geometry measured for a stale width. */
export const FILE_VIEW_LAYOUT_RESIZE_DEBOUNCE_MS = 50;
/** Retain only a bounded set of prepared trees across file, view, and resize churn. */
export const FILE_VIEW_LAYOUT_CACHE_MAX_ENTRIES = 64;
/** Bound warning dedupe metadata retained across input generations for this hook lifetime. */
export const FILE_VIEW_LAYOUT_ISSUE_MAX_ENTRIES = 256;

const EMPTY_RESOLVED_FILE_VIEW_LAYOUTS: ReadonlyMap<string, ResolvedFileViewLayout> = new Map();
const EMPTY_FILE_VIEW_EPOCHS: FileViewEpochState = new Map();

export interface ResolvedFileViewLayout extends ValidatedFileViewLayout {
  key: string;
  extensionId: string;
  viewId: string;
  /** Stable identity for this concrete registration object. */
  registrationIdentity: number;
  /** Changes whenever the host accepts a newly prepared layout. */
  layoutGeneration: number;
}

interface CacheEntry {
  file: DiffFile;
  registered: RegisteredFileView;
  resolved: ResolvedFileViewLayout | null;
}

interface ResolvedEntry {
  file: DiffFile;
  key: string;
  registered: RegisteredFileView;
  width: number;
  resolved: ResolvedFileViewLayout;
}

/** Record a dedupe key while evicting the oldest retained key at the fixed limit. */
function recordBoundedIssue(keys: Set<string>, key: string) {
  if (keys.has(key)) return false;
  if (keys.size >= FILE_VIEW_LAYOUT_ISSUE_MAX_ENTRIES) {
    const oldest = keys.values().next().value;
    if (oldest !== undefined) keys.delete(oldest);
  }
  keys.add(key);
  return true;
}

/**
 * Remove superseded variants for one file/registration before reading or preparing the current one.
 *
 * A variant is one `(width, epoch)` combination of the same prepared tree, so this is what retires
 * both a resized geometry and an epoch an extension has invalidated.
 */
function selectCacheVariant(
  entries: Map<string, CacheEntry>,
  cacheKey: string,
  file: DiffFile,
  registered: RegisteredFileView,
) {
  for (const [key, entry] of entries) {
    if (key !== cacheKey && entry.file.id === file.id && entry.registered === registered) {
      entries.delete(key);
    }
  }
  const cached = entries.get(cacheKey);
  if (cached) {
    // Map insertion order doubles as a small LRU so hot entries survive changeset churn.
    entries.delete(cacheKey);
    entries.set(cacheKey, cached);
  }
  return cached;
}

/** Insert one successful or declined result and evict the oldest retained tree when full. */
function cacheLayoutResult(entries: Map<string, CacheEntry>, key: string, entry: CacheEntry) {
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > FILE_VIEW_LAYOUT_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}

/** Create one layout-owned signal linked to the containing effect. */
function createLayoutController(parentSignal: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    abort();
  } else {
    parentSignal.addEventListener("abort", abort, { once: true });
  }
  return {
    controller,
    detach: () => parentSignal.removeEventListener("abort", abort),
  };
}

/**
 * Run one extension layout with a child cancellation lifetime.
 *
 * The child is aborted on timeout, parent supersession, and successful or failed completion.
 * Every awaited phase races the same budget, so neither third-party layout code nor the host
 * source reads its bindings require can hold a preparation slot past the deadline.
 */
export async function runFileViewLayoutRequest(
  registered: RegisteredFileView,
  file: DiffFile,
  width: number,
  parentSignal: AbortSignal,
  timeoutMs = FILE_VIEW_LAYOUT_TIMEOUT_MS,
  snapshot?: FileViewInputSnapshot,
): Promise<ValidatedFileViewLayout | null> {
  const { controller, detach } = createLayoutController(parentSignal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(new Error("layout timed out"));
        reject(new Error("layout timed out"));
      }, timeoutMs);
    });
    const cancelled = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(new Error("layout aborted"));
        return;
      }
      controller.signal.addEventListener("abort", () => reject(new Error("layout aborted")), {
        once: true,
      });
    });
    // Aborting the controller stops the host from waiting; an already-issued source read may still
    // settle on its own, but it can no longer keep this preparation slot occupied.
    const withinBudget = <T>(work: Promise<T>) => Promise.race([work, deadline, cancelled]);
    const input = createFileViewInput(file, width, controller.signal, snapshot);
    const candidate = await withinBudget(
      Promise.resolve().then(() => registered.view.layout(input)),
    );
    if (controller.signal.aborted || parentSignal.aborted) {
      throw new Error("layout aborted");
    }
    if (candidate === null) {
      return null;
    }
    const checked = validateFileViewLayout(candidate, fileViewHunkCount(file), width);
    if (!checked.valid) {
      throw new Error(`invalid layout: ${checked.issue}`);
    }
    const requiredSides = new Set(
      checked.value.layout.rows.flatMap((row) =>
        (row.sourceRanges ?? []).map((sourceRange) => sourceRange.side),
      ),
    );
    const documents = await withinBudget(
      Promise.all(
        [...requiredSides].map(async (side) => [side, await input.readDocument(side)] as const),
      ).then((entries) => Object.fromEntries(entries)),
    );
    if (controller.signal.aborted || parentSignal.aborted) {
      throw new Error("layout aborted");
    }
    const bindingIssue = validateFileViewSourceRanges(checked.value.layout, documents);
    if (bindingIssue) {
      // Unreadable source is an environment condition, so keep it distinguishable from a layout
      // the extension actually got wrong.
      throw new Error(
        bindingIssue.kind === "unavailable-source"
          ? `unavailable source: ${bindingIssue.detail}`
          : `invalid layout: ${bindingIssue.detail}`,
      );
    }
    return checked.value;
  } finally {
    if (timeout) clearTimeout(timeout);
    detach();
    controller.abort();
  }
}

/** Return whether this render has any alternate file-view work to prepare. */
function hasSelectedFileViews(
  selections: Readonly<Record<string, string>>,
  views: readonly RegisteredFileView[],
) {
  return views.length > 0 && Object.keys(selections).length > 0;
}

/**
 * Run selected file-view layouts outside render and retain only validated results.
 *
 * Raw diff remains visible while preparation is pending or declines the file. A
 * cancellation never reaches an extension as an error toast: resizes, reloads,
 * and changing the selected view are normal control flow.
 *
 * `epochs` carries extension-requested invalidation: bumping a view's epoch makes every
 * prepared tree of that view a stale cache variant, so the files presenting it re-prepare.
 * A file-scoped bump moves the same retention key for one file only, leaving the rest of
 * that view's presenting files on their prepared trees.
 */
export function useFileViewLayouts({
  files,
  selections,
  views,
  width,
  epochs = EMPTY_FILE_VIEW_EPOCHS,
  onIssue,
}: {
  files: readonly DiffFile[];
  selections: Readonly<Record<string, string>>;
  views: readonly RegisteredFileView[];
  width: number;
  epochs?: FileViewEpochState;
  onIssue: (message: string) => void;
}) {
  const cache = useRef(new Map<string, CacheEntry>());
  const registrationIdentities = useRef(new WeakMap<RegisteredFileView, number>());
  const nextRegistrationIdentity = useRef(1);
  const nextLayoutGeneration = useRef(1);
  const previousWidth = useRef<number | undefined>(undefined);
  const reportedIssues = useRef(new Set<string>());
  const [resolved, setResolved] = useState<ReadonlyMap<string, ResolvedEntry>>(new Map());
  const hasSelectedViews = hasSelectedFileViews(selections, views);

  useEffect(() => {
    if (!hasSelectedViews) {
      // Raw diff is implicit. Avoid traversing every file through async workers and committing an
      // empty map after each selection-only render when no alternate presentation is selected.
      if (resolved.size > 0) setResolved(new Map());
      return;
    }

    const controller = new AbortController();
    const next = new Map<string, ResolvedEntry>();
    const widthChanged = previousWidth.current !== undefined && previousWidth.current !== width;
    previousWidth.current = width;
    let active = true;
    let cursor = 0;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const byKey = new Map(views.map((view) => [registeredFileViewKey(view), view]));

    const registrationIdentityFor = (registered: RegisteredFileView) => {
      let identity = registrationIdentities.current.get(registered);
      if (identity === undefined) {
        identity = nextRegistrationIdentity.current++;
        registrationIdentities.current.set(registered, identity);
      }
      return identity;
    };

    const reportOnce = (registered: RegisteredFileView, key: string, message: string) => {
      const identity = registrationIdentityFor(registered);
      if (recordBoundedIssue(reportedIssues.current, `${identity}:${key}`)) onIssue(message);
    };

    const prepareFile = async (file: DiffFile) => {
      const key = selections[file.id];
      if (!key) return;
      const registered = byKey.get(key);
      if (!registered) return;

      const cacheKey = `${file.id}:${key}:${width}:${fileViewLayoutEpoch(epochs, key, file.id)}`;
      const cached = selectCacheVariant(cache.current, cacheKey, file, registered);
      // A valid registration-aware cache hit bypasses even matches(), whose extension code may be
      // expensive or stateful. A reload replaces the registration object and invalidates it.
      if (cached?.file === file && cached.registered === registered) {
        if (cached.resolved) {
          next.set(file.id, { file, key, registered, width, resolved: cached.resolved });
        }
        return;
      }

      const snapshot = createFileViewInputSnapshot(file);
      try {
        if (!registered.view.matches(snapshot.file)) return;
      } catch {
        reportOnce(
          registered,
          `${file.id}:${key}:matches`,
          `Extension ${registered.extensionId} file view "${registered.view.id}" failed matching ${file.path} • using raw diff`,
        );
        return;
      }

      try {
        const validated = await runFileViewLayoutRequest(
          registered,
          file,
          width,
          controller.signal,
          FILE_VIEW_LAYOUT_TIMEOUT_MS,
          snapshot,
        );
        if (controller.signal.aborted || !active) return;
        if (validated === null) {
          cacheLayoutResult(cache.current, cacheKey, { file, registered, resolved: null });
          return;
        }
        const registrationIdentity = registrationIdentityFor(registered);
        const prepared: ResolvedFileViewLayout = {
          ...validated,
          key,
          extensionId: registered.extensionId,
          viewId: registered.view.id,
          registrationIdentity,
          layoutGeneration: nextLayoutGeneration.current++,
        };
        cacheLayoutResult(cache.current, cacheKey, { file, registered, resolved: prepared });
        next.set(file.id, { file, key, registered, width, resolved: prepared });
      } catch (error) {
        if (controller.signal.aborted || !active) return;
        const detail = error instanceof Error ? error.message : String(error);
        const view = `Extension ${registered.extensionId} file view "${registered.view.id}"`;
        // Dedupe on the failure category, never on a thrown message an extension could vary.
        const [category, attributed] = detail.startsWith("invalid layout: ")
          ? [detail, `${view} returned an ${detail} • using raw diff`]
          : detail.startsWith("unavailable source: ")
            ? [
                "unavailable-source",
                `${view} needs source for ${file.path} that Hunk could not read • using raw diff`,
              ]
            : ["layout", `${view} failed laying out ${file.path} • using raw diff`];
        reportOnce(registered, `${file.id}:${key}:${category}`, attributed);
        cacheLayoutResult(cache.current, cacheKey, { file, registered, resolved: null });
      }
    };

    const worker = async () => {
      while (active) {
        const index = cursor++;
        const file = files[index];
        if (!file) return;
        await prepareFile(file);
      }
    };

    const prepare = () => {
      void Promise.all(
        Array.from({ length: Math.min(FILE_VIEW_LAYOUT_CONCURRENCY, files.length) }, worker),
      ).then(() => {
        if (active) {
          setResolved((current) => (current.size === 0 && next.size === 0 ? current : next));
        }
      });
    };

    if (widthChanged) {
      startTimer = setTimeout(prepare, FILE_VIEW_LAYOUT_RESIZE_DEBOUNCE_MS);
    } else {
      prepare();
    }

    return () => {
      active = false;
      if (startTimer) clearTimeout(startTimer);
      controller.abort();
    };
  }, [epochs, files, hasSelectedViews, onIssue, selections, views, width]);

  return useMemo(() => {
    if (!hasSelectedViews) return EMPTY_RESOLVED_FILE_VIEW_LAYOUTS;

    const current = new Map<string, ResolvedFileViewLayout>();
    const byKey = new Map(views.map((view) => [registeredFileViewKey(view), view]));
    for (const file of files) {
      const key = selections[file.id];
      const entry = resolved.get(file.id);
      if (
        key &&
        entry?.file === file &&
        entry.key === key &&
        entry.registered === byKey.get(key) &&
        entry.width === width
      ) {
        current.set(file.id, entry.resolved);
      }
    }
    // Effects clean up after render. Exact per-file filtering synchronously declines stale geometry
    // while preserving unaffected files across filtering and another file's selection change.
    // Epoch is deliberately absent from this filter: an invalidated layout still describes the same
    // file at the same width, so it stays on screen until its replacement resolves rather than
    // flashing back to raw diff.
    return current.size > 0 ? current : EMPTY_RESOLVED_FILE_VIEW_LAYOUTS;
  }, [files, hasSelectedViews, resolved, selections, views, width]);
}
