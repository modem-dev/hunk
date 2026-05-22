import { describe, expect, test } from "bun:test";
import { PayloadTooLargeError, readRequestTextWithLimit, utf8ByteLength } from "./limits";

/** Build a streaming request body so the read path runs without a Content-Length header. */
function streamingRequest(byteLength: number, chunkSize = 64 * 1024) {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const remaining = byteLength - sent;
      if (remaining <= 0) {
        controller.close();
        return;
      }

      const size = Math.min(chunkSize, remaining);
      controller.enqueue(new Uint8Array(size).fill(120));
      sent += size;
    },
  });
  let sent = 0;

  return new Request("http://broker.test/api", {
    method: "POST",
    body: stream,
    // Bun requires half-duplex opt-in for streamed request bodies.
    duplex: "half",
  } as RequestInit);
}

describe("readRequestTextWithLimit", () => {
  test("rejects an oversized declared Content-Length before reading the body", async () => {
    const request = new Request("http://broker.test/api", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(10 * 1024 * 1024) },
      body: "ignored",
    });

    await expect(readRequestTextWithLimit(request, 1024)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  test("aborts the stream when a missing Content-Length hides an oversized body", async () => {
    const request = streamingRequest(2 * 1024 * 1024);

    await expect(readRequestTextWithLimit(request, 256 * 1024)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  test("returns the decoded body when it stays under the limit", async () => {
    const request = new Request("http://broker.test/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });

    await expect(readRequestTextWithLimit(request, 1024 * 1024)).resolves.toBe(
      JSON.stringify({ action: "list" }),
    );
  });

  test("treats a missing body as an empty string", async () => {
    const request = new Request("http://broker.test/api", { method: "GET" });

    await expect(readRequestTextWithLimit(request, 1024)).resolves.toBe("");
  });
});

describe("utf8ByteLength", () => {
  test("counts multi-byte characters by their encoded size", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("😀")).toBe(4);
  });
});
