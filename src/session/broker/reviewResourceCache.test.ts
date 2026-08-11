import { describe, expect, test } from "bun:test";
import { reviewDigest } from "../../core/review/identity";
import { ReviewResourceCache } from "./reviewResourceCache";

function descriptor(text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "resource-1",
    kind: "patch" as const,
    generation: "generation-1",
    fileKey: "file-1",
    contentType: "text/x-diff; charset=utf-8" as const,
    byteLength: new TextEncoder().encode(text).byteLength,
    digest: reviewDigest(text),
    ...overrides,
  };
}

describe("ReviewResourceCache", () => {
  test("admits only complete resources with matching size and digest", () => {
    const cache = new ReviewResourceCache();
    const text = "@@ -1 +1 @@\n-old\n+new\n";
    cache.setComplete("session-1", "generation-1", descriptor(text), Buffer.from(text));
    expect(new TextDecoder().decode(cache.get("session-1", "generation-1", "resource-1"))).toBe(
      text,
    );

    expect(() =>
      cache.setComplete("session-1", "generation-1", descriptor(text), Buffer.from("wrong")),
    ).toThrow("size does not match");
    expect(() =>
      cache.setComplete(
        "session-1",
        "generation-1",
        descriptor(text, { digest: "0".repeat(64) }),
        Buffer.from(text),
      ),
    ).toThrow("digest does not match");
    for (const digest of ["short", "g".repeat(64), "0".repeat(65)]) {
      expect(() =>
        cache.reserve("session-1", "generation-1", descriptor(text, { digest })),
      ).toThrow("not complete");
    }
  });

  test("reserves strict maxima for incomplete source and canonical resources only", () => {
    const cache = new ReviewResourceCache({ perResourceBytes: 32, inFlightBytes: 64 });
    const canonical = descriptor("", {
      kind: "canonical-file",
      contentType: "application/vnd.hunk.review-file+json; charset=utf-8",
      byteLength: undefined,
      digest: undefined,
    });
    const reservation = cache.reserveMaterialization("session-1", "generation-1", canonical, 16);
    expect(reservation).toMatchObject({ byteLength: 16, exact: false });
    cache.release(reservation);

    expect(() =>
      cache.reserveMaterialization(
        "session-1",
        "generation-1",
        descriptor("", { byteLength: undefined, digest: undefined }),
        16,
      ),
    ).toThrow("invalid");

    const busy = new ReviewResourceCache({
      perResourceBytes: 32,
      perGenerationBytes: 128,
      perSessionBytes: 256,
      daemonBytes: 256,
      inFlightBytes: 128,
    });
    busy.setComplete(
      "session-1",
      "generation-1",
      descriptor("x", { byteLength: 1, digest: reviewDigest("x") }),
      Buffer.from("x"),
    );
    const reservations = Array.from({ length: 4 }, (_, index) =>
      busy.reserveMaterialization(
        "session-1",
        "generation-1",
        { ...canonical, id: `canonical-${index}` },
        32,
      ),
    );
    expect(busy.getEntryCount()).toBe(0);
    expect(busy.getReservationCount()).toBe(4);
    for (const active of reservations) busy.release(active);
  });

  test("enforces per-resource bounds and evicts completed LRU entries within generation/session limits", () => {
    const bytes = Buffer.from("12345");
    expect(() =>
      new ReviewResourceCache({ perResourceBytes: 4 }).setComplete(
        "session-1",
        "generation-1",
        descriptor("12345"),
        bytes,
      ),
    ).toThrow("per-resource");

    const generationCache = new ReviewResourceCache({ perGenerationBytes: 8 });
    generationCache.setComplete("session-1", "generation-1", descriptor("12345"), bytes);
    generationCache.setComplete(
      "session-1",
      "generation-1",
      descriptor("6789", { id: "resource-2", byteLength: 4, digest: reviewDigest("6789") }),
      Buffer.from("6789"),
    );
    expect(generationCache.get("session-1", "generation-1", "resource-1")).toBeUndefined();
    expect(generationCache.get("session-1", "generation-1", "resource-2")).toBeDefined();

    const sessionCache = new ReviewResourceCache({ perGenerationBytes: 10, perSessionBytes: 8 });
    sessionCache.setComplete("session-1", "generation-1", descriptor("12345"), bytes);
    sessionCache.setComplete(
      "session-1",
      "generation-2",
      descriptor("6789", {
        id: "resource-2",
        generation: "generation-2",
        byteLength: 4,
        digest: reviewDigest("6789"),
      }),
      Buffer.from("6789"),
    );
    expect(sessionCache.get("session-1", "generation-1", "resource-1")).toBeUndefined();
    expect(sessionCache.get("session-1", "generation-2", "resource-2")).toBeDefined();
  });

  test("enforces daemon-wide in-flight reservations and evicts complete resources by LRU", () => {
    const cache = new ReviewResourceCache({
      perGenerationBytes: 20,
      perSessionBytes: 20,
      daemonBytes: 8,
      inFlightBytes: 8,
    });
    const first = descriptor("aaaa", { byteLength: 4, digest: reviewDigest("aaaa") });
    const second = descriptor("bbbb", {
      id: "resource-2",
      byteLength: 4,
      digest: reviewDigest("bbbb"),
    });
    const third = descriptor("cccc", {
      id: "resource-3",
      byteLength: 4,
      digest: reviewDigest("cccc"),
    });
    cache.setComplete("session-1", "generation-1", first, Buffer.from("aaaa"));
    cache.setComplete("session-1", "generation-1", second, Buffer.from("bbbb"));
    expect(cache.get("session-1", "generation-1", "resource-1")).toBeDefined();
    cache.setComplete("session-1", "generation-1", third, Buffer.from("cccc"));
    expect(cache.get("session-1", "generation-1", "resource-2")).toBeUndefined();
    expect(cache.get("session-1", "generation-1", "resource-1")).toBeDefined();

    const reserved = cache.reserve(
      "session-2",
      "generation-1",
      descriptor("12345", { id: "resource-4" }),
    );
    expect(() =>
      cache.reserve(
        "session-3",
        "generation-1",
        descriptor("6789", {
          id: "resource-5",
          byteLength: 4,
          digest: reviewDigest("6789"),
        }),
      ),
    ).toThrow("in-flight");
    expect(cache.getReservationCount()).toBe(1);
    cache.release(reserved);
    expect(cache.getReservationCount()).toBe(0);

    const concurrencyCache = new ReviewResourceCache({ inFlightResources: 1 });
    const zero = descriptor("", { byteLength: 0, digest: reviewDigest("") });
    const zeroReservation = concurrencyCache.reserve("session-1", "generation-1", zero);
    expect(() =>
      concurrencyCache.reserve(
        "session-2",
        "generation-1",
        descriptor("", { id: "resource-zero-2", byteLength: 0, digest: reviewDigest("") }),
      ),
    ).toThrow("concurrency");
    concurrencyCache.release(zeroReservation);

    const countCache = new ReviewResourceCache({ daemonResources: 1 });
    countCache.setComplete("session-1", "generation-1", zero, new Uint8Array());
    countCache.setComplete(
      "session-2",
      "generation-1",
      descriptor("", { id: "resource-zero-2", byteLength: 0, digest: reviewDigest("") }),
      new Uint8Array(),
    );
    expect(countCache.get("session-1", "generation-1", "resource-1")).toBeUndefined();
    expect(countCache.getEntryCount()).toBe(1);

    const concurrentCountCache = new ReviewResourceCache({
      daemonResources: 2,
      inFlightResources: 10,
    });
    const firstZero = descriptor("", { id: "zero-1", digest: reviewDigest("") });
    const secondZero = descriptor("", { id: "zero-2", digest: reviewDigest("") });
    const thirdZero = descriptor("", { id: "zero-3", digest: reviewDigest("") });
    const firstReservation = concurrentCountCache.reserve("session-1", "generation-1", firstZero);
    const secondReservation = concurrentCountCache.reserve("session-2", "generation-1", secondZero);
    expect(() => concurrentCountCache.reserve("session-3", "generation-1", thirdZero)).toThrow(
      "entry limit",
    );
    concurrentCountCache.complete(firstReservation, firstZero, new Uint8Array());
    const thirdReservation = concurrentCountCache.reserve("session-3", "generation-1", thirdZero);
    expect(concurrentCountCache.getEntryCount()).toBe(0);
    expect(concurrentCountCache.getReservationCount()).toBe(2);
    concurrentCountCache.complete(secondReservation, secondZero, new Uint8Array());
    concurrentCountCache.complete(thirdReservation, thirdZero, new Uint8Array());
    expect(concurrentCountCache.getEntryCount()).toBe(2);
    expect(concurrentCountCache.getReservationCount()).toBe(0);
  });

  test("evicts retired generations and disconnected sessions", () => {
    const cache = new ReviewResourceCache();
    cache.setComplete("session-1", "generation-1", descriptor("one"), Buffer.from("one"));
    cache.setComplete(
      "session-1",
      "generation-2",
      descriptor("two", {
        id: "resource-2",
        generation: "generation-2",
        byteLength: 3,
        digest: reviewDigest("two"),
      }),
      Buffer.from("two"),
    );
    cache.evictGeneration("session-1", "generation-1");
    expect(cache.getEntryCount()).toBe(1);
    cache.evictSession("session-1");
    expect(cache.getEntryCount()).toBe(0);
  });
});
