import { describe, expect, test } from "bun:test";
import { streamToLines } from "./stdinLines";

/** Build a ReadableStream that emits the given byte chunks in order. */
function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!);
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of source) lines.push(line);
  return lines;
}

describe("streamToLines", () => {
  test("yields complete lines from a single chunk", async () => {
    const stream = streamFrom([new TextEncoder().encode("alpha\nbeta\ngamma\n")]);
    expect(await collect(streamToLines(stream))).toEqual(["alpha", "beta", "gamma"]);
  });

  test("emits trailing partial line on stream end", async () => {
    const stream = streamFrom([new TextEncoder().encode("alpha\nbeta")]);
    expect(await collect(streamToLines(stream))).toEqual(["alpha", "beta"]);
  });

  test("handles \\r\\n line endings", async () => {
    const stream = streamFrom([new TextEncoder().encode("alpha\r\nbeta\r\n")]);
    expect(await collect(streamToLines(stream))).toEqual(["alpha", "beta"]);
  });

  test("reassembles a line split across chunks mid-line", async () => {
    const enc = new TextEncoder();
    const stream = streamFrom([enc.encode("hel"), enc.encode("lo\nwo"), enc.encode("rld\n")]);
    expect(await collect(streamToLines(stream))).toEqual(["hello", "world"]);
  });

  test("reassembles a line whose \\r\\n is split across chunks", async () => {
    const enc = new TextEncoder();
    const stream = streamFrom([enc.encode("alpha\r"), enc.encode("\nbeta\n")]);
    expect(await collect(streamToLines(stream))).toEqual(["alpha", "beta"]);
  });

  test("reassembles a UTF-8 codepoint split across chunks", async () => {
    // The character "🚀" is 4 bytes in UTF-8 (0xF0 0x9F 0x9A 0x80). Split it between chunks.
    const rocket = new TextEncoder().encode("🚀");
    expect(rocket.length).toBe(4);
    const part1 = rocket.slice(0, 2);
    const part2 = rocket.slice(2);
    const enc = new TextEncoder();
    const stream = streamFrom([enc.encode("pre:"), part1, part2, enc.encode(":post\n")]);
    expect(await collect(streamToLines(stream))).toEqual(["pre:🚀:post"]);
  });

  test("handles empty stream", async () => {
    const stream = streamFrom([]);
    expect(await collect(streamToLines(stream))).toEqual([]);
  });

  test("handles consecutive newlines as empty lines", async () => {
    const stream = streamFrom([new TextEncoder().encode("a\n\nb\n")]);
    expect(await collect(streamToLines(stream))).toEqual(["a", "", "b"]);
  });
});
