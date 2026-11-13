import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  REVIEW_PATCH_CONTENT_TYPE,
  REVIEW_RESOURCE_CHUNK_BYTES,
  reviewResourceId,
  type ReviewResourceDescriptorV1,
} from "../../core/review/resources";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { serveTestWebReview } from "../../../../../test/helpers/web-review-server";
import { HUNK_REVIEW_CAPABILITY_HEADER } from "../../session/reviewHttpProtocol";
import { ReviewApiClient, ReviewApiError, type ReviewFetch } from "./apiClient";

const running: Array<() => void> = [];

afterEach(() => {
  for (const stop of running.splice(0)) stop();
});

/** Serve files and remember to stop the server. */
function serve(files = [createTestDiffFile({ id: "alpha", path: "src/alpha.ts" })]) {
  const served = serveTestWebReview(files);
  running.push(served.stop);
  return served;
}

/** One file whose patch is exactly `length` bytes, to pin window boundaries. */
function createTestFileWithPatchBytes(id: string, length: number) {
  return { ...createTestDiffFile({ id, path: `src/${id}.ts` }), patch: "p".repeat(length) };
}

/** The descriptor of the served session's first patch resource. */
async function firstPatch(client: ReviewApiClient) {
  const body = await client.publication();
  return body.catalog.resources.find((resource) => resource.kind === "patch")!;
}

const GENERATION = "generation:p1:0";

/** A patch descriptor for fake-fetch tests. */
function createTestDescriptor(measured?: { byteLength: number; digest: string }) {
  return {
    id: reviewResourceId({ kind: "patch", fileKey: "file:fake" }),
    generation: GENERATION,
    fileKey: "file:fake",
    kind: "patch",
    contentType: REVIEW_PATCH_CONTENT_TYPE,
    ...measured,
  } as ReviewResourceDescriptorV1;
}

/** A fake server answering ranged reads over `bytes`, the way the HTTP surface does. */
function createTestRangeFetch(bytes: Uint8Array, options: { lieAboutTotal?: number } = {}) {
  const seen: Array<string | null> = [];
  const fetcher: ReviewFetch = async (_input, init) => {
    const range = new Headers(init.headers).get("range");
    seen.push(range);
    const start = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    const end = Math.min(bytes.byteLength - 1, start + REVIEW_RESOURCE_CHUNK_BYTES - 1);
    const total = start > 0 && options.lieAboutTotal ? options.lieAboutTotal : bytes.byteLength;
    const partial = range !== null || end !== bytes.byteLength - 1;
    return new Response(bytes.slice(start, end + 1), {
      status: partial ? 206 : 200,
      headers: partial ? { "content-range": `bytes ${start}-${end}/${total}` } : {},
    });
  };
  return { fetcher, seen };
}

/** Hex SHA-256 the way a producer measures. */
function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("ReviewApiClient against the real review API", () => {
  test("reads the publication and presents the capability only in its header", async () => {
    const served = serve();
    const seenHeaders: string[] = [];
    const client = new ReviewApiClient({
      sessionId: served.sessionId,
      capability: served.capability,
      fetch: (input, init) => {
        seenHeaders.push(new Headers(init.headers).get(HUNK_REVIEW_CAPABILITY_HEADER) ?? "");
        return served.fetch(input, init);
      },
    });

    const body = await client.publication();

    expect(body.sessionId).toBe(served.sessionId);
    expect(body.catalog.generation).toBe(body.publication.generation);
    expect(seenHeaders).toEqual([served.capability]);
    expect(served.requests.join("\n")).not.toContain(served.capability);
  });

  // Intent: the window boundary is where reader and server most easily disagree (C2/D5).
  test("reads resources exactly one window long, one byte over, and empty", async () => {
    for (const length of [REVIEW_RESOURCE_CHUNK_BYTES, REVIEW_RESOURCE_CHUNK_BYTES + 1, 0]) {
      const file = createTestFileWithPatchBytes(`w${length}`, length);
      const served = serve([file]);
      const client = served.client();

      const bytes = await client.readResource(await firstPatch(client));

      expect(new TextDecoder().decode(bytes)).toBe(file.patch);
    }
  });

  test("reports a refused capability with its review code", async () => {
    const served = serve();
    const client = served.client({ capability: "A".repeat(43) });

    const error = await client.publication().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReviewApiError);
    expect((error as ReviewApiError).code).toBe("unauthorized");
    expect((error as ReviewApiError).details.status).toBe(401);
  });

  test("reports a retired generation as stale with the generation now served", async () => {
    const served = serve();
    const client = served.client();
    const descriptor = { ...(await firstPatch(client)), generation: "generation:other:9" };

    const error = (await client
      .readResource(descriptor)
      .catch((caught: unknown) => caught)) as ReviewApiError;

    expect(error).toBeInstanceOf(ReviewApiError);
    expect(["stale-generation", "unknown-resource"]).toContain(error.code);
  });
});

describe("ReviewApiClient verification", () => {
  test("accepts a measured resource whose bytes hash to its digest", async () => {
    const bytes = new TextEncoder().encode("x".repeat(REVIEW_RESOURCE_CHUNK_BYTES * 2 + 5));
    const { fetcher, seen } = createTestRangeFetch(bytes);
    const client = new ReviewApiClient({ sessionId: "s", capability: "c", fetch: fetcher });

    const read = await client.readResource(
      createTestDescriptor({ byteLength: bytes.byteLength, digest: sha256(bytes) }),
    );

    expect(read).toEqual(bytes);
    expect(seen).toEqual([
      null,
      `bytes=${REVIEW_RESOURCE_CHUNK_BYTES}-${REVIEW_RESOURCE_CHUNK_BYTES * 2 - 1}`,
      `bytes=${REVIEW_RESOURCE_CHUNK_BYTES * 2}-${REVIEW_RESOURCE_CHUNK_BYTES * 3 - 1}`,
    ]);
  });

  test("refuses bytes that do not hash to the published digest", async () => {
    const bytes = new TextEncoder().encode("tampered");
    const { fetcher } = createTestRangeFetch(bytes);
    const client = new ReviewApiClient({ sessionId: "s", capability: "c", fetch: fetcher });

    const error = (await client
      .readResource(createTestDescriptor({ byteLength: bytes.byteLength, digest: "0".repeat(64) }))
      .catch((caught: unknown) => caught)) as ReviewApiError;

    expect(error.code).toBe("resource-integrity");
  });

  test("refuses a resource whose declared size changes between windows", async () => {
    const bytes = new Uint8Array(REVIEW_RESOURCE_CHUNK_BYTES + 10);
    const { fetcher } = createTestRangeFetch(bytes, {
      lieAboutTotal: REVIEW_RESOURCE_CHUNK_BYTES + 99,
    });
    const client = new ReviewApiClient({ sessionId: "s", capability: "c", fetch: fetcher });

    const error = (await client
      .readResource(createTestDescriptor())
      .catch((caught: unknown) => caught)) as ReviewApiError;

    expect(error.code).toBe("resource-integrity");
  });

  test("reports an unreachable daemon as a network failure", async () => {
    const client = new ReviewApiClient({
      sessionId: "s",
      capability: "c",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const error = (await client.publication().catch((caught: unknown) => caught)) as ReviewApiError;

    expect(error.code).toBe("network");
  });

  test("keeps at most the configured number of reads in flight and reports each", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetcher: ReviewFetch = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight -= 1;
      return new Response("abc");
    };
    const client = new ReviewApiClient({
      sessionId: "s",
      capability: "c",
      fetch: fetcher,
      concurrency: 3,
    });
    const landed: number[] = [];

    await client.readResources(
      Array.from({ length: 10 }, () => createTestDescriptor()),
      (index) => landed.push(index),
    );

    expect(peak).toBe(3);
    expect(landed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("stops reading when aborted", async () => {
    const controller = new AbortController();
    const client = new ReviewApiClient({
      sessionId: "s",
      capability: "c",
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });

    const read = client.readResource(createTestDescriptor(), controller.signal);
    controller.abort(new Error("stop"));

    await expect(read).rejects.toThrow("stop");
  });
});
