import { stripTerminalControl } from "./ansi";

/**
 * Streaming patch chunker.
 *
 * Consumes a line iterator and emits one event per file boundary. The text inside each
 * `file` event is the verbatim chunk that the diff parser would have received from the
 * legacy `splitPatchIntoFileChunks` helper, so per-chunk parsing produces identical
 * results without ever materializing the whole patch.
 *
 * When the input is a `git log -p` stream, the chunker also captures each commit's
 * metadata block (the `commit <sha>`, `Author:`, `Date:`, blank, and message lines).
 * That verbatim text rides along on the next file event as `commitHeaderText`, so the
 * renderer can intersperse plain-text commit headers above each commit's first file
 * the way `git log -p` displays them in `less`.
 */

export type ChunkEvent = {
  type: "file";
  chunkText: string;
  /**
   * Verbatim commit metadata block, including the `commit <sha>` line, Author/Date headers,
   * blank lines, and the indented commit message. Set only on the first file event under
   * each commit; null otherwise.
   */
  commitHeaderText: string | null;
};

const GIT_FILE_HEADER = /^diff --git /;
const MINUS_HEADER = /^--- /;
const PLUS_HEADER = /^\+\+\+ /;
// `git log` default format. Anchored at line start; tolerates the `(HEAD -> branch)`
// decorator that `--decorate` adds. Context lines inside hunks start with ` `, `+`, or
// `-`, so they cannot match.
const COMMIT_HEADER = /^commit [0-9a-f]{7,40}\b/;

/**
 * Drive the chunker over a line iterator. Yields one `file` event per detected boundary,
 * including the trailing file (flushed at end-of-stream). When `commit <sha>` headers
 * appear in the stream, the captured metadata block rides along on the next file event.
 */
export async function* chunkPatchStream(lines: AsyncIterable<string>): AsyncGenerator<ChunkEvent> {
  let current: string[] = [];
  let inFile = false;
  let sawGitHeader = false;
  // One-line lookahead so `--- ` boundaries (which require checking the next line for
  // `+++ `) can be recognized without re-buffering.
  let pending: string | null = null;
  // Verbatim commit metadata buffer. Filled while we're inside a commit-header block;
  // attached to the next file event and cleared.
  let commitHeaderBuffer: string[] | null = null;
  let inCommitMeta = false;

  const takeCommitHeaderText = (): string | null => {
    if (!commitHeaderBuffer || commitHeaderBuffer.length === 0) return null;
    const text = `${commitHeaderBuffer.join("\n").trimEnd()}\n`;
    commitHeaderBuffer = null;
    return text;
  };

  const flush = (): ChunkEvent | null => {
    if (!inFile || current.length === 0) {
      current = [];
      inFile = false;
      return null;
    }
    const chunkText = `${current.join("\n").trimEnd()}\n`;
    current = [];
    inFile = false;
    return { type: "file", chunkText, commitHeaderText: takeCommitHeaderText() };
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

    // Inside a commit-metadata block, accumulate every line verbatim until a file or
    // commit header appears. Header lines fall through to the normal handlers, which
    // close the metadata block by leaving inCommitMeta unset on the way out.
    if (inCommitMeta && !GIT_FILE_HEADER.test(stripped) && !COMMIT_HEADER.test(stripped)) {
      commitHeaderBuffer!.push(raw);
      continue;
    }

    if (COMMIT_HEADER.test(stripped)) {
      // A new commit terminates any open file. Flush it carrying any prior commit's
      // header text. Then start a fresh metadata buffer with this commit line as line 1.
      const fileEvent = flush();
      if (fileEvent) yield fileEvent;
      commitHeaderBuffer = [raw];
      inCommitMeta = true;
      continue;
    }

    if (GIT_FILE_HEADER.test(stripped)) {
      const fileEvent = flush();
      if (fileEvent) yield fileEvent;
      inCommitMeta = false;
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
        const fileEvent = flush();
        if (fileEvent) yield fileEvent;
        inCommitMeta = false;
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
