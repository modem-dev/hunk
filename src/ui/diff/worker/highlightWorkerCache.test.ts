import { describe, expect, test } from "bun:test";
import { compactHighlightTransferList, type CompactHighlightedDiff } from "./highlightCompact";
import { HighlightWorkerCache } from "./highlightWorkerCache";

/** Builds one valid compact payload with a predictable retained size. */
function createTestCompactPayload(lineCount = 1): CompactHighlightedDiff {
  return {
    version: 1,
    foregroundPalette: ["#keyword"],
    deletion: {
      lineOffsets: Uint32Array.from({ length: lineCount + 1 }, (_, index) => index),
      starts: Uint32Array.from({ length: lineCount }, () => 0),
      ends: Uint32Array.from({ length: lineCount }, () => 4),
      styleIds: Uint16Array.from({ length: lineCount }, () => 1),
      flags: new Uint8Array(lineCount),
    },
    addition: {
      lineOffsets: Uint32Array.of(0),
      starts: new Uint32Array(),
      ends: new Uint32Array(),
      styleIds: new Uint16Array(),
      flags: new Uint8Array(),
    },
  };
}

describe("highlight worker cache", () => {
  test("returns a transferable clone without detaching its retained payload", () => {
    const cache = new HighlightWorkerCache();
    const payload = createTestCompactPayload();
    cache.set("first", payload);

    const firstResponse = cache.get("first");
    expect(firstResponse).toBeDefined();
    expect(firstResponse).not.toBe(payload);
    expect(firstResponse?.deletion.starts).not.toBe(payload.deletion.starts);

    const transferred = structuredClone(firstResponse!, {
      transfer: compactHighlightTransferList(firstResponse!),
    });
    expect(firstResponse?.deletion.starts.byteLength).toBe(0);
    expect(transferred.deletion.starts).toEqual(Uint32Array.of(0));
    expect(cache.get("first")?.deletion.starts).toEqual(Uint32Array.of(0));
  });

  test("evicts the least-recently-used payload under its byte budget", () => {
    const payload = createTestCompactPayload();
    const onePayloadBytes = new HighlightWorkerCache();
    onePayloadBytes.set("measure", payload);
    const cache = new HighlightWorkerCache(onePayloadBytes.getCachedBytes() * 2);

    cache.set("first", createTestCompactPayload());
    cache.set("second", createTestCompactPayload());
    expect(cache.get("first")).toBeDefined();
    cache.set("third", createTestCompactPayload());

    expect(cache.get("first")).toBeDefined();
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("third")).toBeDefined();
  });

  test("skips an oversized payload without evicting a fitting resident entry", () => {
    const payload = createTestCompactPayload();
    const measured = new HighlightWorkerCache();
    measured.set("measure", payload);
    const cache = new HighlightWorkerCache(measured.getCachedBytes());
    expect(cache.set("fitting", payload)).toBe(true);
    expect(cache.set("oversized", createTestCompactPayload(2))).toBe(false);

    expect(cache.get("fitting")).toBeDefined();
    expect(cache.get("oversized")).toBeUndefined();
  });

  test("releases a replaced payload's previous byte charge", () => {
    const payload = createTestCompactPayload();
    const measured = new HighlightWorkerCache();
    measured.set("measure", payload);
    const cache = new HighlightWorkerCache(measured.getCachedBytes() * 2);

    cache.set("reloaded", createTestCompactPayload());
    cache.set("reloaded", createTestCompactPayload(2));
    cache.set("kept", createTestCompactPayload());

    expect(cache.get("reloaded")).toBeUndefined();
    expect(cache.get("kept")).toBeDefined();
  });
});
