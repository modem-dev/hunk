/**
 * Streaming stdin → line iterator.
 *
 * Decodes a UTF-8 byte stream incrementally and yields complete lines as soon as their
 * terminating newline arrives. Trailing partial line is yielded on stream end. Normalizes
 * \r\n to \n so downstream consumers can match patterns by `^...$` without dual handling.
 */

export interface LineSource extends AsyncIterable<string> {}

/** Convert any byte ReadableStream into a line iterator. */
export function streamToLines(stream: ReadableStream<Uint8Array>): LineSource {
  return {
    [Symbol.asyncIterator]() {
      return iterate(stream);
    },
  };
}

/** Default: read process stdin as lines. Allows injecting a stream for tests. */
export function stdinLines(stream?: ReadableStream<Uint8Array>): LineSource {
  const source = stream ?? Bun.stdin.stream();
  return streamToLines(source);
}

async function* iterate(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let carry = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        // Flush any remaining bytes the decoder is still holding.
        const tail = decoder.decode();
        if (tail) carry += tail;
        if (carry) {
          // Emit the trailing partial line. Strip a lone trailing \r so callers can match `\n`-style patterns.
          yield carry.endsWith("\r") ? carry.slice(0, -1) : carry;
        }
        return;
      }

      carry += decoder.decode(value, { stream: true });

      let newlineIndex = carry.indexOf("\n");
      while (newlineIndex !== -1) {
        let line = carry.slice(0, newlineIndex);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        yield line;
        carry = carry.slice(newlineIndex + 1);
        newlineIndex = carry.indexOf("\n");
      }
    }
  } finally {
    // Best-effort release. If the reader is already closed, releaseLock throws — swallow it.
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}
