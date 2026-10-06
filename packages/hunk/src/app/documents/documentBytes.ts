import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { DocumentReadResult } from "../../core/documents/source";

export const DOCUMENT_MAX_BYTES = 1024 * 1024;

/** Read at most the viewing limit plus one byte, including files that grow while being read. */
export async function readBoundedDocumentBytes(handle: FileHandle, signal?: AbortSignal) {
  const buffer = Buffer.alloc(DOCUMENT_MAX_BYTES + 1);
  let count = 0;
  while (count < buffer.length) {
    signal?.throwIfAborted();
    const result = await handle.read(buffer, count, buffer.length - count, count);
    if (!result.bytesRead) break;
    count += result.bytesRead;
  }
  signal?.throwIfAborted();
  return buffer.subarray(0, count);
}

/** Hash original bytes without normalizing newlines or removing a UTF-8 BOM. */
export function documentBytesIdentity(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Decode bounded UTF-8 document bytes or explain why the viewer cannot display them. */
export function decodeDocumentBytes(bytes: Buffer): DocumentReadResult {
  if (bytes.length > DOCUMENT_MAX_BYTES)
    return {
      kind: "unavailable",
      reason: "too-large",
      detail: "File exceeds the 1 MiB viewing limit.",
    };
  if (bytes.includes(0))
    return {
      kind: "unavailable",
      reason: "binary",
      detail: "Binary file — no text preview.",
    };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "unavailable", reason: "binary", detail: "Non-UTF-8 file — no text preview." };
  }
  return { kind: "text", text, identity: documentBytesIdentity(bytes) };
}

/** Save through a retained handle and truncate only after every edited byte has been written. */
export async function writeDocumentBytes(handle: FileHandle, bytes: Buffer) {
  let count = 0;
  while (count < bytes.length) {
    const result = await handle.write(bytes, count, bytes.length - count, count);
    if (!result.bytesWritten) throw new Error("Cannot save editor output.");
    count += result.bytesWritten;
  }
  await handle.truncate(bytes.length);
}
