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
  test("cancels an oversized declared body without pulling it", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request("http://broker.test/api", {
      method: "POST",
      headers: { "content-length": String(10 * 1024 * 1024) },
      body,
      duplex: "half",
    } as RequestInit);

    await expect(readRequestTextWithLimit(request, 1024)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
    expect({ pulls, cancelled }).toEqual({ pulls: 0, cancelled: true });
  });

  test("aborts the stream when a missing Content-Length hides an oversized body", async () => {
    const request = streamingRequest(2 * 1024 * 1024);

    await expect(readRequestTextWithLimit(request, 256 * 1024)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  test("cancels a malformed declared body without pulling it", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request("http://broker.test/api", {
      method: "POST",
      headers: { "content-length": "01" },
      body,
      duplex: "half",
    } as RequestInit);
    await expect(readRequestBytesWithLimit(request, 1024)).rejects.toBeInstanceOf(
      InvalidContentLengthError,
    );
    expect({ pulls, cancelled }).toEqual({ pulls: 0, cancelled: true });
  });

  test("rejects a full aggregate budget before pulling and cancels the request body", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request("http://broker.test/api", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    const budget = new ResourceBudget(4, "http");
    const occupied = budget.reserve(4);

    await expect(readRequestBytesWithReservation(request, 4, budget)).rejects.toBeInstanceOf(
      BrokerCapacityError,
    );
    expect({ pulls, cancelled, used: budget.used }).toEqual({
      pulls: 0,
      cancelled: true,
      used: 4,
    });
    occupied.release();
  });

  test("charges the maximum before reading a body whose declared length is dishonest", async () => {
    const budget = new ResourceBudget(8, "http");
    const request = new Request("http://broker.test/api", {
      method: "POST",
      headers: { "content-length": "1" },
      body: "1234",
    });
    const read = await readRequestBytesWithReservation(request, 4, budget);
    expect(new TextDecoder().decode(read.bytes)).toBe("1234");
    expect(budget.used).toBe(4);
    read.reservation.release();
    expect(budget.used).toBe(0);
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
  test("rejects a full aggregate budget before pulling and cancels the response body", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const budget = new ResourceBudget(4, "response");
    const occupied = budget.reserve(4);
    const response = await boundHttpResponse(new Response(body), 4, budget);
    expect(response.status).toBe(503);
    expect({ pulls, cancelled, used: budget.used }).toEqual({
      pulls: 0,
      cancelled: true,
      used: 4,
    });
    occupied.release();
  });

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
  test("counts multi-byte characters and replacement sequences without allocating", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("\ud800")).toBe(3);
    expect(utf8ByteLength("\udc00")).toBe(3);
  });
});
