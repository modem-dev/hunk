import { useEffect, useRef, useState } from "react";
import type { DiffFile } from "../../core/types";
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
/** Retain a bounded set of per-(file, highlighter) results across epoch and reload churn. */
export const LINE_HIGHLIGHT_CACHE_MAX_ENTRIES = 512;
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

/** Insert one result and evict the oldest retained entry when full. */
function cacheResult(entries: Map<string, CacheEntry>, key: string, entry: CacheEntry) {
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > LINE_HIGHLIGHT_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
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
  const cached = entries.get(cacheKey);
  if (cached) {
    // Map insertion order doubles as a small LRU so hot entries survive churn.
    entries.delete(cacheKey);
    entries.set(cacheKey, cached);
  }
  return cached;
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
  const [resolved, setResolved] = useState(EMPTY_RESOLVED_LINE_HIGHLIGHTS);

  useEffect(() => {
    if (highlighters.length === 0) {
      setResolved((current) => (current.size > 0 ? EMPTY_RESOLVED_LINE_HIGHLIGHTS : current));
      return;
    }

    const controller = new AbortController();
    const next = new Map<string, readonly ValidatedLineHighlight[]>();
    let active = true;
    let cursor = 0;

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
      if (file.isBinary || file.isTooLarge || file.metadata.hunks.length === 0) return;

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
            cacheResult(cache.current, cacheKey, { file, registered, marks: null });
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
          cacheResult(cache.current, cacheKey, { file, registered, marks });
          accept(registered, marks);
        } catch {
          if (controller.signal.aborted || !active) return;
          reportOnce(
            registered,
            `${file.id}:highlight`,
            `${attribution} failed highlighting ${file.path} • marks dropped`,
          );
          cacheResult(cache.current, cacheKey, { file, registered, marks: null });
          accept(registered, null);
        }
      }

      if (!parts.some((part) => part !== null && part.length > 0)) {
        mergedByFile.current.delete(file.id);
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
        next.set(file.id, previous.merged);
        return;
      }
      const merged = parts.flatMap((part) => part ?? []);
      mergedByFile.current.set(file.id, { parts, merged });
      next.set(file.id, merged);
    };

    const worker = async () => {
      while (active) {
        const index = cursor++;
        const file = files[index];
        if (!file) return;
        await prepareFile(file);
      }
    };

    void Promise.all(
      Array.from({ length: Math.min(LINE_HIGHLIGHT_CONCURRENCY, files.length) }, worker),
    ).then(() => {
      if (!active) return;
      setResolved((current) => {
        // Keep the previous map identity when nothing changed, so re-running
        // this effect over equivalent inputs can never trigger a render loop.
        if (current.size === next.size) {
          let unchanged = true;
          for (const [fileId, marks] of next) {
            if (current.get(fileId) !== marks) {
              unchanged = false;
              break;
            }
          }
          if (unchanged) return current;
        }
        return next;
      });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [epochs, files, highlighters, onIssue]);

  return highlighters.length === 0 ? EMPTY_RESOLVED_LINE_HIGHLIGHTS : resolved;
}
