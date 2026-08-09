import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ReviewCanonicalFileResourceDescriptorV1 } from "../../core/review/types";
import { BrowserReviewApiClient } from "./apiClient";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function descriptor(
  generation: string,
  id = "canonical:1",
  content = "{}",
): ReviewCanonicalFileResourceDescriptorV1 {
  return {
    id,
    kind: "canonical-file",
    generation,
    fileKey: id,
    contentType: "application/vnd.hunk.review-file+json; charset=utf-8",
    byteLength: content.length,
    digest: createHash("sha256").update(content).digest("hex"),
  };
}

describe("browser canonical resource queue", () => {
  test("selection and note revisions reuse one generation resource fetch", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response("{}", { status: 200, headers: { "content-length": "2" } });
    }) as unknown as typeof fetch;
    const client = new BrowserReviewApiClient("session");
    client.replaceGeneration("generation:1");
    const resource = descriptor("generation:1");
    expect(await client.resource("generation:1", resource)).toBe("{}");
    expect(await client.resource("generation:1", resource)).toBe("{}");
    expect(requests).toBe(1);
  });

  test("generation replacement aborts obsolete inflight and queued work", async () => {
    let aborted = 0;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted += 1;
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch;
    const client = new BrowserReviewApiClient("session");
    client.replaceGeneration("generation:old");
    const pending = client.resource("generation:old", descriptor("generation:old"));
    client.replaceGeneration("generation:new");
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(aborted).toBe(1);
  });

  test("retries a released resource without an obsolete rejection deleting the retry cache", async () => {
    let requests = 0;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      if (requests > 1) return Promise.resolve(new Response("{}", { status: 200 }));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    const client = new BrowserReviewApiClient("session");
    const generation = "generation:retry";
    const resource = descriptor(generation);
    client.replaceGeneration(generation);
    const controller = new AbortController();
    const obsolete = client.resource(generation, resource, controller.signal);
    controller.abort();
    client.releaseResource(generation, resource.id);
    await expect(obsolete).rejects.toHaveProperty("name", "AbortError");
    expect(await client.resource(generation, resource)).toBe("{}");
    expect(await client.resource(generation, resource)).toBe("{}");
    expect(requests).toBe(2);
  });

  test("never starts more than six large-review resources concurrently", async () => {
    let active = 0;
    let maximum = 0;
    globalThis.fetch = (async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Bun.sleep(10);
      active -= 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const client = new BrowserReviewApiClient("session");
    client.replaceGeneration("generation:large");
    const pending = Array.from({ length: 20 }, (_, index) =>
      client.resource("generation:large", descriptor("generation:large", `canonical:${index}`)),
    );
    await Promise.all(pending);
    expect(maximum).toBe(6);
  });
});
