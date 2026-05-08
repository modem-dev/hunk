import { parsePatchFiles } from "@pierre/diffs";
import { buildDiffFile } from "../loaders";
import type {
  AgentContext,
  Changeset,
  ChangesetStreamHandle,
  ChangesetStreamListener,
  DiffFile,
} from "../types";
import { chunkPatchStream } from "./patchChunker";

/**
 * Streaming changeset producer.
 *
 * Wraps the patch chunker, parses each `file` event with the existing diff parser, and
 * pushes batched appends to subscribers. The shape lets `AppHost` start with an empty
 * changeset and grow it incrementally without remounting.
 */

export interface ChangesetStream extends ChangesetStreamHandle {
  initialChangeset: Changeset;
}

export interface CreateChangesetStreamOptions {
  source: AsyncIterable<string>;
  sourceLabel: string;
  title: string;
  agentContext?: AgentContext | null;
  /** Override the batching debounce window. Defaults to 16 ms (~one frame). */
  batchIntervalMs?: number;
  /** Override the eager-flush watermark. Defaults to 32 files. */
  batchWatermark?: number;
}

const DEFAULT_BATCH_INTERVAL_MS = 16;
const DEFAULT_BATCH_WATERMARK = 32;

/** Create a streaming changeset bound to a line source. Subscribers see incremental appends. */
export function createChangesetStream(opts: CreateChangesetStreamOptions): ChangesetStream {
  const sourceLabel = opts.sourceLabel;
  const agentContext = opts.agentContext ?? null;
  const batchInterval = opts.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
  const watermark = opts.batchWatermark ?? DEFAULT_BATCH_WATERMARK;

  const initialChangeset: Changeset = {
    id: `changeset:${Date.now()}`,
    sourceLabel,
    title: opts.title,
    agentSummary: agentContext?.summary,
    files: [],
    isStreaming: true,
  };

  const listeners = new Set<ChangesetStreamListener>();
  const abort = new AbortController();

  let pendingFiles: DiffFile[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let totalFiles = 0;
  let nextIndex = 0;

  const flush = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingFiles.length === 0) return;
    const batch = pendingFiles;
    pendingFiles = [];
    for (const listener of listeners) {
      try {
        listener.onAppend(batch);
      } catch (err) {
        listener.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  const scheduleFlush = () => {
    if (pendingFiles.length >= watermark) {
      flush();
      return;
    }
    if (flushTimer === null) {
      flushTimer = setTimeout(flush, batchInterval);
    }
  };

  const run = async () => {
    try {
      for await (const event of chunkPatchStream(opts.source)) {
        if (abort.signal.aborted) break;

        let parsed: ReturnType<typeof parsePatchFiles>;
        try {
          parsed = parsePatchFiles(event.chunkText, "patch", false);
        } catch (err) {
          // A single malformed chunk shouldn't kill the whole stream. Log and skip.
          console.warn(
            `[hunk:pager-stream] failed to parse file chunk: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }

        // Attach commit metadata (when present) to the first parsed file under this chunk.
        // Subsequent files in the same chunk — rare, parsePatchFiles can return multiple
        // entries for one input — get nothing, mirroring the chunker's invariant.
        let headerAttached = false;
        for (const entry of parsed) {
          for (const metadata of entry.files) {
            const diffFile = buildDiffFile(
              metadata,
              event.chunkText,
              nextIndex,
              sourceLabel,
              agentContext,
            );
            if (!headerAttached && event.commitHeaderText) {
              diffFile.commitHeaderText = event.commitHeaderText;
              headerAttached = true;
            }
            pendingFiles.push(diffFile);
            nextIndex += 1;
            totalFiles += 1;
          }
        }

        scheduleFlush();
      }
      flush();
      for (const listener of listeners) listener.onComplete(totalFiles);
    } catch (err) {
      flush();
      const error = err instanceof Error ? err : new Error(String(err));
      for (const listener of listeners) listener.onError(error);
    }
  };

  // Run on the next tick so subscribers added immediately after creation aren't missed.
  queueMicrotask(() => {
    void run();
  });

  return {
    initialChangeset,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort() {
      abort.abort();
      flush();
    },
  };
}
