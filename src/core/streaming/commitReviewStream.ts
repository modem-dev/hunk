import type {
  AgentContext,
  Changeset,
  CommitChangeset,
  CommitReviewStreamHandle,
  CommitReviewStreamListener,
  DiffFile,
} from "../types";
import { createChangesetStream } from "./changesetStream";
import { parseCommitMetadata } from "./commitMetadata";

/**
 * Streaming commit-by-commit producer.
 *
 * Wraps the per-file changesetStream and groups files into one `CommitChangeset` per
 * commit. Emits each commit when its boundary is detected (the next commit's first
 * file arrives) or on stream completion. Files with no commit context (e.g. a single
 * `git diff` piped to `hunk pager --no-review` would never reach this stream, but a
 * malformed log might) are bucketed into an "anonymous" commit with empty sha/subject.
 */

export interface CreateCommitReviewStreamOptions {
  source: AsyncIterable<string>;
  sourceLabel: string;
  title: string;
  agentContext?: AgentContext | null;
  /** Override the commit lookahead high/low watermarks. */
  lookaheadCommitsHigh?: number;
  lookaheadCommitsLow?: number;
}

export interface CommitReviewStream extends CommitReviewStreamHandle {
  initialBuffer: { commits: CommitChangeset[]; streaming: boolean };
}

const DEFAULT_LOOKAHEAD_HIGH = 10;
const DEFAULT_LOOKAHEAD_LOW = 5;

/**
 * Create a commit-review stream. The consumer subscribes once and receives one
 * `onCommit` event per parsed commit; back-pressure is applied based on the commit
 * cursor reported via `setConsumedCommitIndex`.
 */
export function createCommitReviewStream(
  opts: CreateCommitReviewStreamOptions,
): CommitReviewStream {
  const sourceLabel = opts.sourceLabel;
  const lookaheadCommitsHigh = opts.lookaheadCommitsHigh ?? DEFAULT_LOOKAHEAD_HIGH;
  const lookaheadCommitsLow = opts.lookaheadCommitsLow ?? DEFAULT_LOOKAHEAD_LOW;

  // The underlying file stream uses a commits-only watermark in this mode: pathological
  // merge commits that touch thousands of files render as one large commit, by design.
  // The file watermark is set to effectively-infinity so the commit watermark is the
  // sole pause/resume gate.
  const fileStream = createChangesetStream({
    source: opts.source,
    sourceLabel,
    title: opts.title,
    agentContext: opts.agentContext,
    lookahead: {
      commitsHigh: lookaheadCommitsHigh,
      commitsLow: lookaheadCommitsLow,
      filesHigh: Number.MAX_SAFE_INTEGER,
      filesLow: Number.MAX_SAFE_INTEGER,
    },
  });

  const listeners = new Set<CommitReviewStreamListener>();
  let parsedCommitCount = 0;
  // Replay buffer: commits emitted before any subscriber existed are kept here so a
  // late subscriber sees the full history.
  const replayCommits: CommitChangeset[] = [];
  let completed = false;
  let completionTotal = 0;
  let lastError: Error | null = null;

  // Active commit accumulator: when a file with commitHeaderText arrives, flush the
  // accumulator (if any) as a CommitChangeset, then start a fresh one.
  let pendingFiles: DiffFile[] = [];
  let pendingHeaderText: string | null = null;

  const flushPending = () => {
    if (pendingFiles.length === 0) return;
    const metadata = parseCommitMetadata(pendingHeaderText ?? "");
    const commitId = metadata.sha || `anonymous:${parsedCommitCount}`;
    const changeset: Changeset = {
      id: `commit:${commitId}`,
      sourceLabel,
      title: metadata.subject || metadata.shortSha || "anonymous commit",
      summary: metadata.body || undefined,
      files: pendingFiles,
      isStreaming: false,
    };
    const commit: CommitChangeset = { metadata, changeset };
    pendingFiles = [];
    pendingHeaderText = null;

    const index = parsedCommitCount;
    parsedCommitCount += 1;
    replayCommits.push(commit);
    for (const listener of listeners) {
      try {
        listener.onCommit(commit, index);
      } catch (err) {
        listener.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  fileStream.subscribe({
    onAppend: (files) => {
      for (const file of files) {
        if (file.commitHeaderText) {
          // New commit boundary. Flush whatever was buffered for the previous one.
          flushPending();
          pendingHeaderText = file.commitHeaderText;
          // The commitHeaderText only needs to live on the first file for the renderer's
          // legacy preamble, but we also have it parsed into metadata now. Keep the field
          // intact so fallback paths still work.
        }
        pendingFiles.push(file);
      }
    },
    onComplete: () => {
      flushPending();
      completed = true;
      completionTotal = parsedCommitCount;
      for (const listener of listeners) listener.onComplete(parsedCommitCount);
    },
    onError: (err) => {
      flushPending();
      lastError = err;
      for (const listener of listeners) listener.onError(err);
    },
  });

  return {
    initialBuffer: { commits: [], streaming: true },
    subscribe(listener) {
      listeners.add(listener);
      // Replay everything the listener missed.
      for (let i = 0; i < replayCommits.length; i += 1) {
        try {
          listener.onCommit(replayCommits[i]!, i);
        } catch (err) {
          listener.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      if (completed) listener.onComplete(completionTotal);
      else if (lastError) listener.onError(lastError);
      return () => listeners.delete(listener);
    },
    setConsumedCommitIndex(index: number) {
      // Forward to the underlying file-stream as a position signal. The fileIndex
      // contribution doesn't matter because the file watermark is effectively disabled,
      // so we just pass the cursor's commit index and a corresponding file index that's
      // safely past everything in or before that commit.
      fileStream.setConsumedPosition(index, Number.MAX_SAFE_INTEGER);
    },
    abort() {
      fileStream.abort();
    },
  };
}
