import { describe, expect, test } from "bun:test";
import {
  InvalidContentLengthError,
  PayloadTooLargeError,
  boundHttpResponse,
  readRequestBytesWithLimit,
  readRequestBytesWithReservation,
  readRequestTextWithLimit,
  utf8ByteLength,
} from "./limits";
import { BrokerCapacityError, ResourceBudget } from "./budgets";

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

  test("rejects malformed Content-Length instead of treating it as undeclared", async () => {
    const request = new Request("http://broker.test/api", {
      method: "POST",
      headers: { "content-length": "01" },
      body: "x",
    });
    await expect(readRequestBytesWithLimit(request, 1024)).rejects.toBeInstanceOf(
      InvalidContentLengthError,
    );
  });

  test("accounts source-plus-merged peak and transfers retained body capacity", async () => {
    const budget = new ResourceBudget(8, "http");
    const request = new Request("http://broker.test/api", { method: "POST", body: "éé" });
    const read = await readRequestBytesWithReservation(request, 4, budget);
    expect(read.bytes.byteLength).toBe(4);
    expect(budget.used).toBe(4);
    expect(budget.tryReserve(5)).toBeNull();
    read.reservation.release();
    read.reservation.release();
    expect(budget.used).toBe(0);
  });

  test("rolls back a failed merged-copy peak reservation for reuse", async () => {
    const budget = new ResourceBudget(7, "http");
    const request = new Request("http://broker.test/api", { method: "POST", body: "1234" });
    await expect(readRequestBytesWithReservation(request, 4, budget)).rejects.toBeInstanceOf(
      BrokerCapacityError,
    );
    expect(budget.used).toBe(0);
    const reused = budget.reserve(7);
    reused.release();
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

  test("returns exact bytes and rejects malformed UTF-8 only during strict text decoding", async () => {
    const bytes = new Uint8Array([0x7b, 0xc0, 0xaf, 0x7d]);
    const byteRequest = new Request("http://broker.test/api", { method: "POST", body: bytes });
    await expect(readRequestBytesWithLimit(byteRequest, 1024)).resolves.toEqual(bytes);

    const textRequest = new Request("http://broker.test/api", { method: "POST", body: bytes });
    await expect(readRequestTextWithLimit(textRequest, 1024)).rejects.toBeInstanceOf(TypeError);
  });

  test("treats a missing body as an empty string", async () => {
    const request = new Request("http://broker.test/api", { method: "GET" });

    await expect(readRequestTextWithLimit(request, 1024)).resolves.toBe("");
  });
});

describe("boundHttpResponse", () => {
  test("accepts an exact-ceiling response and charges it until pull", async () => {
    const budget = new ResourceBudget(8, "response");
    const response = await boundHttpResponse(new Response("1234"), 4, budget);
    expect(response.status).toBe(200);
    expect(budget.used).toBe(4);
    expect(await response.text()).toBe("1234");
    expect(budget.used).toBe(0);
  });

  test("releases a retained response reservation when its body is cancelled", async () => {
    const budget = new ResourceBudget(8, "response");
    const response = await boundHttpResponse(new Response("1234"), 4, budget);
    expect(budget.used).toBe(4);
    await response.body!.cancel();
    expect(budget.used).toBe(0);
  });

  test("rolls back a failed response-copy peak reservation for reuse", async () => {
    const budget = new ResourceBudget(7, "response");
    const response = await boundHttpResponse(new Response("1234"), 4, budget);
    expect(response.status).toBe(503);
    expect(budget.used).toBe(0);
    const reused = budget.reserve(7);
    reused.release();
  });

  test("cancels a declared-oversized response body before rejecting it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = await boundHttpResponse(
      new Response(body, { headers: { "content-length": "5" } }),
      4,
    );
    expect(response.status).toBe(503);
    expect(cancelled).toBe(true);
  });
});

describe("utf8ByteLength", () => {
  test("counts multi-byte characters by their encoded size", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("😀")).toBe(4);
  });
});
