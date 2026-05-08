import { parsePatchFiles } from "@pierre/diffs";
import { buildDiffFile } from "../loaders";
import type {
  AgentContext,
  Changeset,
  ChangesetStreamHandle,
  ChangesetStreamListener,
  CommitRef,
  DiffFile,
} from "../types";
import { chunkPatchStream, type ChunkEvent } from "./patchChunker";

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
    commits: [],
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

  const handleFileEvent = (event: Extract<ChunkEvent, { type: "file" }>) => {
    let parsed: ReturnType<typeof parsePatchFiles>;
    try {
      parsed = parsePatchFiles(event.chunkText, "patch", false);
    } catch (err) {
      // Single chunk can't bring down the stream. Log and skip.
      console.warn(
        `[hunk:pager-stream] failed to parse file chunk: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    for (const entry of parsed) {
      for (const metadata of entry.files) {
        const diffFile = buildDiffFile(
          metadata,
          event.chunkText,
          nextIndex,
          sourceLabel,
          agentContext,
        );
        if (event.commitId) diffFile.commitId = event.commitId;
        pendingFiles.push(diffFile);
        nextIndex += 1;
        totalFiles += 1;
      }
    }

    scheduleFlush();
  };

  const handleCommitEvent = (event: Extract<ChunkEvent, { type: "commit" }>) => {
    const commit: CommitRef = {
      id: event.id,
      subject: event.subject,
      author: event.author,
      date: event.date,
      // Phase 3 closes ranges as files arrive; for Phase 2 we keep the placeholder open.
      fileRange: { start: nextIndex, end: nextIndex },
    };
    for (const listener of listeners) listener.onCommit?.(commit);
  };

  const run = async () => {
    try {
      for await (const event of chunkPatchStream(opts.source)) {
        if (abort.signal.aborted) break;
        if (event.type === "file") handleFileEvent(event);
        else if (event.type === "commit") handleCommitEvent(event);
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
