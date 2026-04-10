import type { FileDiffMetadata } from "@pierre/diffs";
import fs from "node:fs";

const BINARY_SNIFF_BYTES = 8_000;
const BINARY_CONTROL_BYTE_RATIO = 0.3;

/** Return whether one diff patch explicitly marks the file contents as binary. */
export function patchLooksBinary(patch: string) {
  return (
    /(^|\n)Binary files .* differ(?:\n|$)/.test(patch) || patch.includes("\nGIT binary patch\n")
  );
}

/** Build placeholder metadata for one skipped binary file without inventing fake hunks. */
export function createSkippedBinaryMetadata(
  name: string,
  type: FileDiffMetadata["type"] = "change",
): FileDiffMetadata {
  return {
    name,
    type,
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    additionLines: [],
    deletionLines: [],
    cacheKey: `${name}:binary-skipped`,
  };
}

/** Read only a small prefix from disk so binary detection never loads the whole file. */
function readFilePrefix(path: string) {
  let fd: number | undefined;

  try {
    fd = fs.openSync(path, "r");
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** Return whether one byte is a strong binary signal instead of normal text content. */
function isBinarySignalByte(byte: number) {
  return byte < 0x07 || (byte > 0x0d && byte < 0x20) || byte === 0x7f;
}

/** Detect likely binary files from a small prefix using Git-style control-byte heuristics. */
export function isProbablyBinaryFile(path: string) {
  let prefix: Uint8Array;

  try {
    prefix = readFilePrefix(path);
  } catch {
    return false;
  }

  if (prefix.length === 0) {
    return false;
  }

  let binarySignalBytes = 0;

  for (const byte of prefix) {
    if (byte === 0) {
      return true;
    }

    if (isBinarySignalByte(byte)) {
      binarySignalBytes += 1;
    }
  }

  return binarySignalBytes / prefix.length >= BINARY_CONTROL_BYTE_RATIO;
}
