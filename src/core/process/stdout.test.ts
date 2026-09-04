import { describe, expect, test } from "bun:test";
import { writeStdout } from "./stdout";

/**
 * Record descriptor writes, optionally accepting only part of each chunk.
 *
 * Chunks are kept as bytes and decoded once at the end: a partial write can split a multi-byte
 * character, so decoding each chunk on its own would report corruption the descriptor never saw.
 */
function createRecordingWrite(acceptBytes?: number) {
  const chunks: Buffer[] = [];
  const writeImpl = (_fd: number, buffer: Uint8Array, offset: number, length: number) => {
    const written = acceptBytes === undefined ? length : Math.min(acceptBytes, length);
    chunks.push(Buffer.from(Buffer.from(buffer).subarray(offset, offset + written)));
    return written;
  };
  return { chunks, writeImpl, text: () => Buffer.concat(chunks).toString("utf8") };
}

/** Build an errno failure the way `writeSync` reports one. */
function errnoError(code: string) {
  return Object.assign(new Error(code), { code });
}

describe("writeStdout", () => {
  test("hands the whole document to the descriptor", () => {
    const recorder = createRecordingWrite();

    writeStdout("hello pager", { writeImpl: recorder.writeImpl });

    expect(recorder.text()).toBe("hello pager");
  });

  test("resumes partial writes until the consumer has taken every byte", () => {
    // A pipe accepts one buffer at a time, so a large document is always written in pieces.
    const document = "x".repeat(200_000);
    const recorder = createRecordingWrite(65_536);

    writeStdout(document, { writeImpl: recorder.writeImpl });

    expect(recorder.text()).toBe(document);
    expect(recorder.chunks.length).toBeGreaterThan(1);
  });

  test("preserves multi-byte characters split across partial writes", () => {
    const document = "日本語".repeat(1_000);
    const recorder = createRecordingWrite(7);

    writeStdout(document, { writeImpl: recorder.writeImpl });

    expect(recorder.text()).toBe(document);
  });

  test("waits for room instead of spinning when the descriptor is non-blocking", () => {
    const recorder = createRecordingWrite();
    const sleeps: number[] = [];
    let refusals = 2;

    writeStdout("deferred", {
      writeImpl: (fd, buffer, offset, length) => {
        if (refusals > 0) {
          refusals -= 1;
          throw errnoError("EAGAIN");
        }
        return recorder.writeImpl(fd, buffer, offset, length);
      },
      sleepImpl: (ms) => sleeps.push(ms),
    });

    expect(recorder.text()).toBe("deferred");
    expect(sleeps).toEqual([1, 1]);
  });

  test("stops quietly when the consumer closes early", () => {
    const recorder = createRecordingWrite(4);

    expect(() =>
      writeStdout("long document", {
        writeImpl: (fd, buffer, offset, length) => {
          if (offset > 0) {
            throw errnoError("EPIPE");
          }
          return recorder.writeImpl(fd, buffer, offset, length);
        },
      }),
    ).not.toThrow();

    expect(recorder.text()).toBe("long");
  });

  test("surfaces unexpected descriptor failures", () => {
    expect(() =>
      writeStdout("text", {
        writeImpl: () => {
          throw errnoError("ENOSPC");
        },
      }),
    ).toThrow("ENOSPC");
  });
});
