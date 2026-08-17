import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile } from "../../core/changeset/model";
import type { ExtensionLineHighlightInput } from "../../extension-api/types";
import { toReadOnlyFileViews } from "../../extensions/events";
import type { RegisteredLineHighlighter } from "../../extensions/types";
import { createExtensionDocumentReader } from "../lib/extensionDocumentReader";
import { scopedEpoch } from "../lib/scopedEpochs";
import { registeredLineHighlighterKey, type LineHighlightEpochState } from "./state";
import {
  MAX_MERGED_LINE_HIGHLIGHTS_PER_FILE,
  validateLineHighlights,
  type ValidatedLineHighlight,
} from "./validate";

/** Bound asynchronous third-party highlight work so marks never stall the review. */
export const LINE_HIGHLIGHT_TIMEOUT_MS = 1_500;
/** Keep extension preparation parallel but bounded across a large changeset. */
export const LINE_HIGHLIGHT_CONCURRENCY = 4;
/** Bound warning dedupe metadata retained for this hook lifetime. */
const LINE_HIGHLIGHT_ISSUE_MAX_ENTRIES = 256;

const EMPTY_RESOLVED_LINE_HIGHLIGHTS: ReadonlyMap<string, readonly ValidatedLineHighlight[]> =
  new Map();
const EMPTY_EPOCHS: LineHighlightEpochState = new Map();

interface CacheEntry {
  file: DiffFile;
  registered: RegisteredLineHighlighter;
  /** `null` when the highlighter answered "no marks" or failed for this file. */
  marks: readonly ValidatedLineHighlight[] | null;
}

/** One file's merged marks, tagged with the inputs that produced them. */
interface ResolvedEntry {
  file: DiffFile;
  highlighters: readonly RegisteredLineHighlighter[];
  marks: readonly ValidatedLineHighlight[];
}

/** Record a dedupe key while evicting the oldest retained key at the fixed limit. */
function recordBoundedIssue(keys: Set<string>, key: string) {
  if (keys.has(key)) return false;
  if (keys.size >= LINE_HIGHLIGHT_ISSUE_MAX_ENTRIES) {
    const oldest = keys.values().next().value;
    if (oldest !== undefined) keys.delete(oldest);
  }
  keys.add(key);
  return true;
}

/**
 * Drop retained results the current generation can no longer read.
 *
 * Retention is scoped to the live `(file, highlighter)` objects rather than to
 * a fixed entry ceiling: a reload replaces both, so an older entry is dead
 * weight the moment it stops matching. A ceiling instead evicted live entries
 * once a review carried more pairs than the ceiling, which turned one file's
 * `ctx.highlights.refresh` into a rerun of unrelated files.
 */
function retainActiveResults(
  entries: Map<string, CacheEntry>,
  files: readonly DiffFile[],
  highlighters: readonly RegisteredLineHighlighter[],
) {
  const activeFiles = new Set(files);
  const activeHighlighters = new Set(highlighters);
  for (const [key, entry] of entries) {
    if (!activeFiles.has(entry.file) || !activeHighlighters.has(entry.registered)) {
      entries.delete(key);
    }
  }
}

/**
 * Remove superseded epoch variants for one file/registration before consulting the cache.
 *
 * A variant is one epoch of the same derivation, so this is what retires the
 * results a `ctx.highlights.refresh` invalidated.
 */
function selectCacheVariant(
  entries: Map<string, CacheEntry>,
  cacheKey: string,
  file: DiffFile,
  registered: RegisteredLineHighlighter,
) {
  for (const [key, entry] of entries) {
    if (key !== cacheKey && entry.file.id === file.id && entry.registered === registered) {
      entries.delete(key);
    }
  }
  return entries.get(cacheKey);
}

/**
 * Run one highlighter for one file with a bounded lifetime.
 *
 * The request aborts on timeout, supersession, and completion, so third-party
 * highlight code can never hold a preparation slot past the deadline.
 */
export async function runLineHighlightRequest(
  registered: RegisteredLineHighlighter,
  file: DiffFile,
  parentSignal: AbortSignal,
  timeoutMs = LINE_HIGHLIGHT_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    abort();
  } else {
    parentSignal.addEventListener("abort", abort, { once: true });
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(new Error("highlight timed out"));
        reject(new Error("highlight timed out"));
      }, timeoutMs);
    });
    const cancelled = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(new Error("highlight aborted"));
        return;
      }
      controller.signal.addEventListener("abort", () => reject(new Error("highlight aborted")), {
        once: true,
      });
    });
    const input: ExtensionLineHighlightInput = Object.freeze({
      file: toReadOnlyFileViews([file])[0]!,
      signal: controller.signal,
      readDocument: createExtensionDocumentReader(file, controller.signal),
    });
    const result = await Promise.race([
      Promise.resolve().then(() => registered.highlighter.highlight(input)),
      deadline,
      cancelled,
    ]);
    if (controller.signal.aborted || parentSignal.aborted) {
      throw new Error("highlight aborted");
    }
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
    controller.abort();
  }
}

/**
 * Prepare extension line highlights outside render and retain only validated marks.
 *
 * Marks are a pure derivation of `(file, highlighter, epoch)`: results are
 * cached under that key, an epoch bump re-derives exactly the invalidated
 * entries, and a throwing, rejecting, or timed-out highlighter costs that
 * file's marks from that highlighter and nothing else.
 *
 * Files publish as they finish rather than behind one barrier, so a slow
 * highlighter on one file no longer delays every other file's marks. Published
 * marks carry the file and registration objects they were derived from, and
 * the returned map only exposes the ones still matching this render — marks
 * addressed at one review's text can never paint onto its replacement, which
 * usually reuses the same file ids.
 *
 * The returned map holds one merged, registration-ordered mark array per file
 * with identity stable across renders while its inputs are unchanged, so row
 * memoization downstream keeps holding.
 */
export function useLineHighlights({
  files,
  highlighters,
  epochs = EMPTY_EPOCHS,
  onIssue,
}: {
  files: readonly DiffFile[];
  highlighters: readonly RegisteredLineHighlighter[];
  epochs?: LineHighlightEpochState;
  onIssue: (message: string) => void;
}): ReadonlyMap<string, readonly ValidatedLineHighlight[]> {
  const cache = useRef(new Map<string, CacheEntry>());
  const mergedByFile = useRef(
    new Map<
      string,
      {
        parts: ReadonlyArray<readonly ValidatedLineHighlight[] | null>;
        merged: readonly ValidatedLineHighlight[];
      }
    >(),
  );
  const reportedIssues = useRef(new Set<string>());
  const registrationIdentities = useRef(new WeakMap<RegisteredLineHighlighter, number>());
  const nextRegistrationIdentity = useRef(1);
  const [resolved, setResolved] = useState<ReadonlyMap<string, ResolvedEntry>>(new Map());

  useEffect(() => {
    if (highlighters.length === 0) {
      cache.current.clear();
      setResolved((current) => (current.size > 0 ? new Map() : current));
      return;
    }

    const controller = new AbortController();
    let active = true;
    let cursor = 0;

    retainActiveResults(cache.current, files, highlighters);

    // Retire whatever the previous generation left for files this review no
    // longer carries, so a reload cannot retain its diff trees indefinitely.
    // Files the review still carries republish as their preparation lands.
    const activeFileIds = new Set(files.map((file) => file.id));
    for (const fileId of mergedByFile.current.keys()) {
      if (!activeFileIds.has(fileId)) mergedByFile.current.delete(fileId);
    }
    setResolved((current) => {
      let pruned: Map<string, ResolvedEntry> | undefined;
      for (const fileId of current.keys()) {
        if (activeFileIds.has(fileId)) continue;
        pruned ??= new Map(current);
        pruned.delete(fileId);
      }
      return pruned ?? current;
    });

    // Publication is buffered and flushed on a microtask: a fully cached
    // generation resolves every file synchronously and commits once, while a
    // slow generation still commits each file as it lands.
    const pending = new Map<string, ResolvedEntry | null>();
    let flushScheduled = false;

    const flush = () => {
      flushScheduled = false;
      if (!active || pending.size === 0) return;
      const updates = [...pending];
      pending.clear();
      setResolved((current) => {
        let next: Map<string, ResolvedEntry> | undefined;
        for (const [fileId, entry] of updates) {
          const previous = current.get(fileId);
          if (entry === null) {
            if (!previous) continue;
            next ??= new Map(current);
            next.delete(fileId);
            continue;
          }
          if (
            previous?.file === entry.file &&
            previous.highlighters === entry.highlighters &&
            previous.marks === entry.marks
          ) {
            continue;
          }
          next ??= new Map(current);
          next.set(fileId, entry);
        }
        // Keep the previous map identity when nothing changed, so re-running
        // this effect over equivalent inputs can never trigger a render loop.
        return next ?? current;
      });
    };

    /** Queue one file's marks, or `null` to retire what it published before. */
    const publish = (fileId: string, entry: ResolvedEntry | null) => {
      pending.set(fileId, entry);
      if (flushScheduled) return;
      flushScheduled = true;
      queueMicrotask(flush);
    };

    const registrationIdentityFor = (registered: RegisteredLineHighlighter) => {
      let identity = registrationIdentities.current.get(registered);
      if (identity === undefined) {
        identity = nextRegistrationIdentity.current++;
        registrationIdentities.current.set(registered, identity);
      }
      return identity;
    };

    const reportOnce = (registered: RegisteredLineHighlighter, key: string, message: string) => {
      const identity = registrationIdentityFor(registered);
      if (recordBoundedIssue(reportedIssues.current, `${identity}:${key}`)) onIssue(message);
    };

    const prepareFile = async (file: DiffFile) => {
      // A file with no rows to mark never reaches extension code.
      if (file.isBinary || file.isTooLarge || file.metadata.hunks.length === 0) {
        publish(file.id, null);
        return;
      }

      const parts: Array<readonly ValidatedLineHighlight[] | null> = [];
      let mergedCount = 0;
      /**
       * Keep one highlighter's marks only while the file stays under the merged
       * cap, so a late contributor cannot push paint past what it can carry.
       */
      const accept = (
        registered: RegisteredLineHighlighter,
        marks: readonly ValidatedLineHighlight[] | null,
      ) => {
        if (marks && mergedCount + marks.length > MAX_MERGED_LINE_HIGHLIGHTS_PER_FILE) {
          reportOnce(
            registered,
            `${file.id}:merged-cap`,
            `Extension ${registered.extensionId} line highlighter "${registered.highlighter.id}" ` +
              `pushed ${file.path} past ${MAX_MERGED_LINE_HIGHLIGHTS_PER_FILE} merged ranges • marks dropped`,
          );
          parts.push(null);
          return;
        }
        mergedCount += marks?.length ?? 0;
        parts.push(marks);
      };

      for (const registered of highlighters) {
        const key = registeredLineHighlighterKey(registered);
        const cacheKey = `${file.id}\u0000${key}\u0000${scopedEpoch(epochs, key, file.id)}`;
        const cached = selectCacheVariant(cache.current, cacheKey, file, registered);
        // A registration-aware cache hit bypasses extension code entirely.
        // A reload replaces the registration object and invalidates it.
        if (cached?.file === file && cached.registered === registered) {
          accept(registered, cached.marks);
          continue;
        }

        const attribution = `Extension ${registered.extensionId} line highlighter "${registered.highlighter.id}"`;
        try {
          const raw = await runLineHighlightRequest(registered, file, controller.signal);
          if (controller.signal.aborted || !active) return;
          const validation = validateLineHighlights(raw);
          if (!validation.ok) {
            reportOnce(
              registered,
              `${file.id}:${validation.issue}`,
              `${attribution} ${validation.issue} for ${file.path} • marks dropped`,
            );
            cache.current.set(cacheKey, { file, registered, marks: null });
            accept(registered, null);
            continue;
          }
          if (validation.droppedInvalid > 0) {
            reportOnce(
              registered,
              `${file.id}:invalid-entries`,
              `${attribution} returned ${validation.droppedInvalid} invalid ` +
                `range${validation.droppedInvalid === 1 ? "" : "s"} for ${file.path} • dropped`,
            );
          }
          const marks = validation.marks.length > 0 ? validation.marks : null;
          cache.current.set(cacheKey, { file, registered, marks });
          accept(registered, marks);
        } catch {
          if (controller.signal.aborted || !active) return;
          reportOnce(
            registered,
            `${file.id}:highlight`,
            `${attribution} failed highlighting ${file.path} • marks dropped`,
          );
          cache.current.set(cacheKey, { file, registered, marks: null });
          accept(registered, null);
        }
      }

      if (!parts.some((part) => part !== null && part.length > 0)) {
        mergedByFile.current.delete(file.id);
        publish(file.id, null);
        return;
      }

      // Reuse the previous merged array while every contributing part is identical,
      // so an untouched file keeps one stable identity across epoch bumps elsewhere.
      const previous = mergedByFile.current.get(file.id);
      if (
        previous &&
        previous.parts.length === parts.length &&
        previous.parts.every((part, index) => part === parts[index])
      ) {
        publish(file.id, { file, highlighters, marks: previous.merged });
        return;
      }
      const merged = parts.flatMap((part) => part ?? []);
      mergedByFile.current.set(file.id, { parts, merged });
      publish(file.id, { file, highlighters, marks: merged });
    };

    const worker = async () => {
      while (active) {
        const index = cursor++;
        const file = files[index];
        if (!file) return;
        await prepareFile(file);
      }
    };

    const workerCount = Math.min(LINE_HIGHLIGHT_CONCURRENCY, files.length);
    for (let index = 0; index < workerCount; index += 1) void worker();

    return () => {
      active = false;
      controller.abort();
    };
  }, [epochs, files, highlighters, onIssue]);

  return useMemo(() => {
    if (highlighters.length === 0) return EMPTY_RESOLVED_LINE_HIGHLIGHTS;

    const current = new Map<string, readonly ValidatedLineHighlight[]>();
    for (const file of files) {
      const entry = resolved.get(file.id);
      // Marks address one exact text at one set of registrations. Effects clean
      // up after render, so filtering here is what keeps a reload's first
      // frames from painting the previous review's offsets onto new content
      // under a reused file id.
      if (entry?.file === file && entry.highlighters === highlighters) {
        current.set(file.id, entry.marks);
      }
    }
    return current.size > 0 ? current : EMPTY_RESOLVED_LINE_HIGHLIGHTS;
  }, [files, highlighters, resolved]);
}
