import { stripTerminalControl } from "./ansi";

/**
 * Streaming patch chunker.
 *
 * Consumes a line iterator and emits one event per file boundary. The text inside each
 * `file` event is the verbatim chunk that the diff parser would have received from the
 * legacy `splitPatchIntoFileChunks` helper, so per-chunk parsing produces identical
 * results without ever materializing the whole patch.
 *
 * Phase 2 only knows file boundaries. `commit` events stay reserved for Phase 3, when
 * the IN_COMMIT_META state is implemented and `git log -p` becomes a per-commit review.
 */

export type ChunkEvent =
  | { type: "file"; chunkText: string; commitId: string | null }
  | {
      type: "commit";
      id: string;
      subject: string;
      author?: string;
      date?: string;
    };

const GIT_FILE_HEADER = /^diff --git /;
const MINUS_HEADER = /^--- /;
const PLUS_HEADER = /^\+\+\+ /;

/**
 * Drive the chunker over a line iterator. Yields a `file` event per detected boundary,
 * including the trailing file (flushed at end-of-stream).
 */
export async function* chunkPatchStream(lines: AsyncIterable<string>): AsyncGenerator<ChunkEvent> {
  let current: string[] = [];
  let inFile = false;
  let sawGitHeader = false;
  // One-line lookahead so `--- ` boundaries (which require checking the next line for
  // `+++ `) can be recognized without re-buffering.
  let pending: string | null = null;
  let currentCommitId: string | null = null;

  const flush = (): ChunkEvent | null => {
    if (!inFile || current.length === 0) {
      current = [];
      inFile = false;
      return null;
    }
    const chunkText = `${current.join("\n").trimEnd()}\n`;
    current = [];
    inFile = false;
    return { type: "file", chunkText, commitId: currentCommitId };
  };

  const startFile = (firstLine: string, secondLine?: string) => {
    inFile = true;
    current.push(firstLine);
    if (secondLine !== undefined) current.push(secondLine);
  };

  // Wrap the source so we can re-feed the lookahead line after a flush.
  const iter = lines[Symbol.asyncIterator]();
  const next = async (): Promise<{ value: string; done: false } | { done: true }> => {
    if (pending !== null) {
      const value = pending;
      pending = null;
      return { value, done: false };
    }
    const result = await iter.next();
    if (result.done) return { done: true };
    return { value: result.value, done: false };
  };

  while (true) {
    const step = await next();
    if (step.done) break;

    const raw = step.value;
    const stripped = stripTerminalControl(raw);

    if (GIT_FILE_HEADER.test(stripped)) {
      const event = flush();
      if (event) yield event;
      sawGitHeader = true;
      startFile(raw);
      continue;
    }

    if (!sawGitHeader && MINUS_HEADER.test(stripped)) {
      // Need to look at the following line to confirm a unified-diff boundary.
      const peek = await next();
      if (peek.done) {
        // Trailing `--- ` with no follow-up. If we were already in a file, keep it as content;
        // otherwise drop it (matches legacy behavior of ignoring stray `--- ` outside a file).
        if (inFile) current.push(raw);
        break;
      }

      const peekStripped = stripTerminalControl(peek.value);
      if (PLUS_HEADER.test(peekStripped)) {
        const event = flush();
        if (event) yield event;
        startFile(raw, peek.value);
        continue;
      }

      // False alarm. Push the peeked line back so it gets normal handling on the next loop.
      pending = peek.value;
      if (inFile) current.push(raw);
      continue;
    }

    if (inFile) current.push(raw);
  }

  const tail = flush();
  if (tail) yield tail;
}
