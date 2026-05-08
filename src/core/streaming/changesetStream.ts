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
 *
 * Reading is paced by the consumer through `setConsumedPosition`. Once the lookahead
 * (commits or files parsed beyond the user's current position) exceeds the high
 * watermark, the producer parks until the user advances enough to pull the lookahead
 * back below the low watermark. The OS pipe buffer absorbs the upstream while the
 * producer is parked, so `git log -p` blocks on its own `write()` call without using
 * extra memory.
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
  /** Override the back-pressure watermarks. Defaults are read from env on first call. */
  lookahead?: LookaheadConfig;
}

export interface LookaheadConfig {
  commitsHigh: number;
  commitsLow: number;
  filesHigh: number;
  filesLow: number;
}

const DEFAULT_BATCH_INTERVAL_MS = 16;
const DEFAULT_BATCH_WATERMARK = 32;

const DEFAULT_LOOKAHEAD: LookaheadConfig = {
  commitsHigh: 10,
  commitsLow: 5,
  filesHigh: 2_000,
  filesLow: 1_000,
};

/** Resolve the back-pressure config from env, falling back to defaults. */
function resolveLookahead(override?: LookaheadConfig): LookaheadConfig {
  if (override) return override;
  const envInt = (key: string, fallback: number) => {
    const raw = process.env[key];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    commitsHigh: envInt("HUNK_PAGER_LOOKAHEAD_COMMITS_HIGH", DEFAULT_LOOKAHEAD.commitsHigh),
    commitsLow: envInt("HUNK_PAGER_LOOKAHEAD_COMMITS_LOW", DEFAULT_LOOKAHEAD.commitsLow),
    filesHigh: envInt("HUNK_PAGER_LOOKAHEAD_FILES_HIGH", DEFAULT_LOOKAHEAD.filesHigh),
    filesLow: envInt("HUNK_PAGER_LOOKAHEAD_FILES_LOW", DEFAULT_LOOKAHEAD.filesLow),
  };
}

/** Create a streaming changeset bound to a line source. Subscribers see incremental appends. */
export function createChangesetStream(opts: CreateChangesetStreamOptions): ChangesetStream {
  const sourceLabel = opts.sourceLabel;
  const agentContext = opts.agentContext ?? null;
  const batchInterval = opts.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
  const watermark = opts.batchWatermark ?? DEFAULT_BATCH_WATERMARK;
  const lookahead = resolveLookahead(opts.lookahead);

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
  let parsedCommitCount = 0;
  // Replay buffer: files delivered before any subscriber existed are kept here so a
  // late subscriber sees the full history.
  const replayFiles: DiffFile[] = [];
  let completed = false;
  let completionTotal = 0;
  let lastError: Error | null = null;

  // User position (negative until the consumer has reported one). The math below
  // treats `-1` as "consumer is before the first file", which makes initial reads
  // count their lookahead from zero correctly.
  let userCommitIndex = -1;
  let userFileIndex = -1;
  // Permit machinery: producer awaits `permit` while paused; consumer position
  // updates resolve it when the lookahead drops below the low watermark.
  let permit: Promise<void> | null = null;
  let permitResolve: (() => void) | null = null;

  const lookaheadCounts = () => ({
    commits: parsedCommitCount - userCommitIndex - 1,
    files: nextIndex - userFileIndex - 1,
  });

  const shouldPause = () => {
    const { commits, files } = lookaheadCounts();
    return commits >= lookahead.commitsHigh || files >= lookahead.filesHigh;
  };

  const shouldResume = () => {
    const { commits, files } = lookaheadCounts();
    return commits < lookahead.commitsLow && files < lookahead.filesLow;
  };

  const issuePermit = () => {
    if (permitResolve) {
      const resolve = permitResolve;
      permit = null;
      permitResolve = null;
      resolve();
    }
  };

  const awaitPermit = async () => {
    while (shouldPause() && !abort.signal.aborted) {
      if (!permit) {
        permit = new Promise<void>((resolve) => {
          permitResolve = resolve;
        });
      }
      await permit;
    }
  };

  abort.signal.addEventListener("abort", issuePermit);

  const flush = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingFiles.length === 0) return;
    const batch = pendingFiles;
    pendingFiles = [];
    replayFiles.push(...batch);
    if (listeners.size === 0) return;
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
        await awaitPermit();
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
        if (event.commitHeaderText) parsedCommitCount += 1;

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
            // Tag every file with its owning commit index when the input is commit-aware.
            // Stays undefined for non-commit inputs (single git diff, git show) so that
            // path's behavior is unchanged.
            if (parsedCommitCount > 0) diffFile.commitIndex = parsedCommitCount - 1;
            pendingFiles.push(diffFile);
            nextIndex += 1;
            totalFiles += 1;
          }
        }

        scheduleFlush();
      }
      flush();
      completed = true;
      completionTotal = totalFiles;
      for (const listener of listeners) listener.onComplete(totalFiles);
    } catch (err) {
      flush();
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
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
      // Replay everything the listener missed so a late subscriber sees the full
      // history instead of only future events.
      if (replayFiles.length > 0) {
        try {
          listener.onAppend(replayFiles.slice());
        } catch (err) {
          listener.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      if (completed) listener.onComplete(completionTotal);
      else if (lastError) listener.onError(lastError);
      return () => listeners.delete(listener);
    },
    setConsumedPosition(commitIndex: number, fileIndex: number) {
      const nextCommit = Math.max(userCommitIndex, commitIndex);
      const nextFile = Math.max(userFileIndex, fileIndex);
      if (nextCommit === userCommitIndex && nextFile === userFileIndex) return;
      userCommitIndex = nextCommit;
      userFileIndex = nextFile;
      if (shouldResume()) issuePermit();
    },
    abort() {
      abort.abort();
      flush();
    },
  };
}
