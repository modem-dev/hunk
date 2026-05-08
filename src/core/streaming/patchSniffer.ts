import { stripTerminalControl } from "./ansi";

/**
 * Streaming patch detector.
 *
 * Pulls lines from the source until either a budget is exhausted or a positive patch
 * marker appears, then reports its decision plus the lines already consumed so the
 * downstream stage can re-prepend them. Same regex contract as the legacy
 * `looksLikePatchInput`, just applied to a bounded prefix instead of the whole stream.
 */

export interface SniffResult {
  kind: "patch" | "plain";
  prefixLines: string[];
  rest: AsyncIterator<string>;
}

export interface SniffOptions {
  /** Stop sniffing after this many bytes (UTF-8 length of the joined prefix). */
  maxBytes?: number;
  /** Stop sniffing after this many lines. */
  maxLines?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_LINES = 2_000;

const HEADER_REGEX = /^diff --git /;
const MINUS_HEADER_REGEX = /^--- /;
const PLUS_HEADER_REGEX = /^\+\+\+ /;
const HUNK_HEADER_REGEX = /^@@ /;
// Anchored, bare-hex form. Context lines inside a hunk start with space/+/- and cannot
// match a line beginning with "commit ", so this won't false-positive on diff bodies.
const COMMIT_HEADER_REGEX = /^commit [0-9a-f]{7,40}\b/;

/**
 * Heuristic: does this prefix look like multi-commit `git log -p` output? True if any
 * line in the prefix starts with `commit <sha>`. Used to auto-route log-style input to
 * scroll-only / no-review streaming mode.
 */
export function looksLikeCommitLog(prefixLines: string[]): boolean {
  for (const line of prefixLines) {
    if (COMMIT_HEADER_REGEX.test(stripTerminalControl(line))) return true;
  }
  return false;
}

/** Decide whether a streaming source looks like a patch by inspecting only its prefix. */
export async function sniffPatch(
  source: AsyncIterable<string> | AsyncIterator<string>,
  options: SniffOptions = {},
): Promise<SniffResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const iterator = toIterator(source);

  const prefixLines: string[] = [];
  let byteCount = 0;
  let sawMinus = false;

  while (prefixLines.length < maxLines && byteCount < maxBytes) {
    const next = await iterator.next();
    if (next.done) break;

    prefixLines.push(next.value);
    byteCount += Buffer.byteLength(next.value, "utf8") + 1;

    const stripped = stripTerminalControl(next.value);

    if (HEADER_REGEX.test(stripped) || HUNK_HEADER_REGEX.test(stripped)) {
      return { kind: "patch", prefixLines, rest: iterator };
    }

    if (MINUS_HEADER_REGEX.test(stripped)) sawMinus = true;
    else if (sawMinus && PLUS_HEADER_REGEX.test(stripped)) {
      return { kind: "patch", prefixLines, rest: iterator };
    } else if (sawMinus) {
      // `--- ` was a false positive (no `+++` on the very next line). Reset.
      sawMinus = false;
    }
  }

  return { kind: "plain", prefixLines, rest: iterator };
}

function toIterator<T>(source: AsyncIterable<T> | AsyncIterator<T>): AsyncIterator<T> {
  if (typeof (source as AsyncIterable<T>)[Symbol.asyncIterator] === "function") {
    return (source as AsyncIterable<T>)[Symbol.asyncIterator]();
  }
  return source as AsyncIterator<T>;
}

/** Helper for callers that need to rejoin prefix + rest into a single async iterator. */
export async function* chainLines(
  prefixLines: string[],
  rest: AsyncIterator<string>,
): AsyncGenerator<string> {
  for (const line of prefixLines) yield line;
  while (true) {
    const next = await rest.next();
    if (next.done) return;
    yield next.value;
  }
}

/** Drain a line iterator into a single string with trailing newline (for legacy concat paths). */
export async function drainLines(
  prefixLines: string[],
  rest: AsyncIterator<string>,
): Promise<string> {
  const parts = [...prefixLines];
  while (true) {
    const next = await rest.next();
    if (next.done) break;
    parts.push(next.value);
  }
  return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}
