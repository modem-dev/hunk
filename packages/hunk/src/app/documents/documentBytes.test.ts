import { expect, mock, test } from "bun:test";
import { mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DOCUMENT_MAX_BYTES,
  decodeDocumentBytes,
  documentBytesIdentity,
  readBoundedDocumentBytes,
  writeDocumentBytes,
} from "./documentBytes";

test("bounded byte reads retain one overflow byte and honor cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "hunk-bytes-test-"));
  const path = join(root, "file.txt");
  try {
    await writeFile(path, Buffer.alloc(DOCUMENT_MAX_BYTES + 128, 65));
    const handle = await open(path, "r");
    try {
      const bytes = await readBoundedDocumentBytes(handle);
      expect(bytes.length).toBe(DOCUMENT_MAX_BYTES + 1);
      expect(decodeDocumentBytes(bytes)).toMatchObject({
        kind: "unavailable",
        reason: "too-large",
      });
      const abort = new AbortController();
      abort.abort();
      await expect(readBoundedDocumentBytes(handle, abort.signal)).rejects.toThrow();
    } finally {
      await handle.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("text decoding preserves the raw-byte identity while refusing binary and invalid UTF-8", () => {
  const bytes = Buffer.from("\ufeffcomplete\r\n");
  expect(decodeDocumentBytes(bytes)).toEqual({
    kind: "text",
    text: "complete\r\n",
    identity: documentBytesIdentity(bytes),
  });
  expect(documentBytesIdentity(bytes)).not.toBe(documentBytesIdentity(Buffer.from("complete\r\n")));
  expect(decodeDocumentBytes(Buffer.from([0]))).toMatchObject({
    kind: "unavailable",
    reason: "binary",
  });
  expect(decodeDocumentBytes(Buffer.from([255]))).toMatchObject({
    kind: "unavailable",
    reason: "binary",
  });
});

/** Create a deliberately partial writer to exercise retained-handle save ordering. */
function createTestWriteHandle(stall = false) {
  const writes: Buffer[] = [];
  const truncate = mock(async (_size: number) => undefined);
  const write = mock(async (buffer: Buffer, offset: number, length: number) => {
    const bytesWritten = stall ? 0 : Math.min(length, 2);
    writes.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)));
    return { bytesWritten, buffer };
  });
  return { handle: { write, truncate } as unknown as FileHandle, writes, truncate };
}

test("retained-handle saves finish partial writes before truncation and reject a stalled writer", async () => {
  const writer = createTestWriteHandle();
  await writeDocumentBytes(writer.handle, Buffer.from("saved"));
  expect(Buffer.concat(writer.writes).toString()).toBe("saved");
  expect(writer.truncate).toHaveBeenCalledWith(5);
  const stalled = createTestWriteHandle(true);
  await expect(writeDocumentBytes(stalled.handle, Buffer.from("saved"))).rejects.toThrow(
    "Cannot save editor output.",
  );
  expect(stalled.truncate).not.toHaveBeenCalled();
});
