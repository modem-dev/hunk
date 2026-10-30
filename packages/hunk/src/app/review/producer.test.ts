import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { SourceTextTooLargeError } from "../../core/changeset/fileSource";
import { parseReviewGeneration } from "../../core/review/generationOrder";
import {
  MAX_REVIEW_SOURCE_RESOURCE_BYTES,
  REVIEW_RESOURCE_CHUNK_BYTES,
  reviewResourceId,
} from "../../core/review/resources";
import { createReviewStore } from "../../core/review/store";
import type { DiffFile } from "../../core/changeset/model";
import { parseReadReviewResourceRequest } from "../../core/review/resources";
import { ReviewProducer } from "./producer";

const BEFORE = lines("alpha", "beta", "gamma", "delta");
const AFTER = lines("alpha", "BETA", "gamma", "delta");

/** One producer over a single file, with an optional source reader behind it. */
function createProducer(
  options: {
    files?: DiffFile[];
    resourceConcurrency?: number;
  } = {},
) {
  const files = options.files ?? [createTestDiffFile({ before: BEFORE, after: AFTER })];
  return {
    files,
    producer: new ReviewProducer(
      { files, sourceLabel: "/repo" },
      {
        producerId: "test",
        ...(options.resourceConcurrency !== undefined
          ? { resourceConcurrency: options.resourceConcurrency }
          : {}),
      },
    ),
  };
}

/** Read one whole resource by paging chunks, returning the assembled text. */
async function readWhole(producer: ReviewProducer, resourceId: string, length = 1024) {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const result = await producer.readResource({
      generation: producer.getPublication().generation,
      resourceId,
      offset,
      length,
    });
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    parts.push(Buffer.from(result.chunk.data, "base64"));
    offset += result.chunk.byteLength;
    if (result.chunk.eof) {
      return { text: Buffer.concat(parts).toString("utf8"), chunk: result.chunk };
    }
  }
}

describe("review producer generations", () => {
  test("starts at the first generation of its own producer identity", () => {
    const { producer } = createProducer();
    expect(parseReviewGeneration(producer.getPublication().generation)).toEqual({
      producerId: "test",
      sequence: 0,
    });
  });

  test("publishes the next generation on reload, keeping file keys addressable", () => {
    const { producer, files } = createProducer();
    const before = producer.getPublication();

    const after = producer.publish({
      files: [createTestDiffFile({ before: BEFORE, after: lines("alpha", "BETA!") })],
      sourceLabel: "/repo",
    });

    expect(parseReviewGeneration(after.generation)).toEqual({
      producerId: "test",
      sequence: 1,
    });
    // Same path and source label, so the same address — and different content behind it.
    expect(after.document.files[0]?.key).toBe(before.document.files[0]!.key);
    expect(after.document.files[0]?.contentIdentity).not.toBe(
      before.document.files[0]!.contentIdentity,
    );
    expect(files).toHaveLength(1);
  });

  test("prepares a generation without advancing until a non-throwing commit", () => {
    const { producer } = createProducer();
    const before = producer.getPublication();
    const prepared = producer.preparePublication({
      files: [createTestDiffFile({ before: BEFORE, after: lines("alpha", "BETA!") })],
      sourceLabel: "/repo",
    });

    expect(producer.getPublication()).toBe(before);
    expect(parseReviewGeneration(prepared.publication.generation)?.sequence).toBe(1);

    expect(producer.reservePublication(prepared).commit()).toBe(prepared.publication);
    expect(producer.getPublication()).toBe(prepared.publication);
  });

  test("can detach the previous store until a prepared generation mounts", () => {
    const { producer } = createProducer();
    producer.attachStore(createReviewStore(producer.getPublication().document));
    expect(producer.getPositionedReviewState()).toMatchObject({
      generation: producer.getPublication().generation,
      state: { stateRevision: 0 },
    });
    const prepared = producer.preparePublication({
      files: [createTestDiffFile({ before: BEFORE, after: AFTER })],
      sourceLabel: "/repo",
    });

    producer.reservePublication(prepared).commit({ detachStore: true });

    expect(producer.getReviewState()).toBeUndefined();
    expect(producer.getPositionedReviewState()).toBeUndefined();
    expect(() => producer.applyIntent({ type: "filter/set", filter: "stale" })).toThrow(
      "no review state",
    );
  });

  test("refuses a store left attached across a generation advance until replacement state mounts", () => {
    const { producer } = createProducer();
    producer.attachStore(createReviewStore(producer.getPublication().document));
    const prepared = producer.preparePublication({
      files: [createTestDiffFile({ before: BEFORE, after: AFTER })],
      sourceLabel: "/repo",
    });

    producer.reservePublication(prepared).commit();

    expect(producer.getReviewState()).toBeUndefined();
    expect(producer.getPositionedReviewState()).toBeUndefined();
    expect(() => producer.applyIntent({ type: "filter/set", filter: "retired" })).toThrow(
      "no review state",
    );

    const replacement = createReviewStore(producer.getPublication().document);
    producer.attachStore(replacement);
    expect(producer.getPositionedReviewState()).toEqual({
      generation: producer.getPublication().generation,
      state: replacement.getSnapshot(),
    });
  });

  test("refuses stale, foreign, active, and reused publication preparations", () => {
    const { producer } = createProducer();
    const other = new ReviewProducer({ files: [] }, { producerId: "other" });
    const first = producer.preparePublication({ files: [] });
    const competing = producer.preparePublication({ files: [] });

    expect(() => other.reservePublication(first)).toThrow("another producer");
    const reservation = producer.reservePublication(first);
    expect(() => producer.reservePublication(competing)).toThrow("another reservation is active");
    reservation.commit();
    expect(() => producer.reservePublication(competing)).toThrow("stale");
    expect(() => producer.reservePublication(first)).toThrow("more than once");
  });

  test("cancels a reservation without advancing and cannot reuse its preparation", () => {
    const { producer } = createProducer();
    const before = producer.getPublication();
    const prepared = producer.preparePublication({ files: [] });
    const reservation = producer.reservePublication(prepared);

    reservation.cancel();
    reservation.commit();

    expect(producer.getPublication()).toBe(before);
    expect(() => producer.reservePublication(prepared)).toThrow("more than once");
  });

  test("retires the previous generation's resources", async () => {
    const { producer } = createProducer();
    const stale = producer.getPublication();
    const resourceId = reviewResourceId({
      kind: "patch",
      fileKey: stale.document.files[0]!.key,
    });
    producer.publish({ files: [createTestDiffFile({ before: BEFORE, after: AFTER })] });

    const result = await producer.readResource({
      generation: stale.generation,
      resourceId,
      offset: 0,
      length: 64,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "stale-generation",
      currentGeneration: producer.getPublication().generation,
    });
  });
});

describe("review producer resource reads", () => {
  test("serves a file's patch, digest-verified and marked at its end", async () => {
    const { producer, files } = createProducer();
    const fileKey = producer.getPublication().document.files[0]!.key;

    const { text, chunk } = await readWhole(producer, reviewResourceId({ kind: "patch", fileKey }));

    expect(text).toBe(files[0]!.patch);
    expect(chunk.contentSize).toBe(Buffer.byteLength(files[0]!.patch, "utf8"));
    expect(chunk.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(chunk.eof).toBe(true);
  });

  test("pages a resource in bounded chunks that reassemble to the same digest", async () => {
    const { producer, files } = createProducer();
    const fileKey = producer.getPublication().document.files[0]!.key;
    const resourceId = reviewResourceId({ kind: "patch", fileKey });

    const paged = await readWhole(producer, resourceId, 8);
    const whole = await readWhole(producer, resourceId);

    expect(paged.text).toBe(files[0]!.patch);
    expect(paged.chunk.contentDigest).toBe(whole.chunk.contentDigest);
  });

  test("serves a canonical file that parses back into the published file", async () => {
    const { producer } = createProducer();
    const file = producer.getPublication().document.files[0]!;

    const { text } = await readWhole(
      producer,
      reviewResourceId({ kind: "canonical-file", fileKey: file.key }),
    );

    expect(JSON.parse(text)).toEqual(file);
  });

  test("reports an unknown resource id distinctly", async () => {
    const { producer } = createProducer();

    const result = await producer.readResource({
      generation: producer.getPublication().generation,
      resourceId: reviewResourceId({ kind: "patch", fileKey: "file:deadbeef" }),
      offset: 0,
      length: 16,
    });

    expect(result).toMatchObject({ ok: false, code: "unknown-resource" });
  });

  test("rejects a malformed request without touching any content", async () => {
    const { producer } = createProducer();
    const generation = producer.getPublication().generation;
    const resourceId = reviewResourceId({
      kind: "patch",
      fileKey: producer.getPublication().document.files[0]!.key,
    });

    for (const request of [
      undefined,
      { generation, resourceId, offset: 0 },
      { generation, resourceId, offset: 0, length: 0 },
      { generation, resourceId, offset: -1, length: 4 },
      { generation, resourceId, offset: 0, length: REVIEW_RESOURCE_CHUNK_BYTES + 1 },
      { generation, resourceId, offset: 0, length: 4, extra: true },
      { generation: "nope", resourceId, offset: 0, length: 4 },
    ]) {
      expect(await producer.readResource(request)).toMatchObject({
        ok: false,
        code: "invalid-request",
      });
    }
  });

  test("rejects an offset past the end of the content", async () => {
    const { producer } = createProducer();
    const fileKey = producer.getPublication().document.files[0]!.key;

    const result = await producer.readResource({
      generation: producer.getPublication().generation,
      resourceId: reviewResourceId({ kind: "patch", fileKey }),
      offset: 1_000_000,
      length: 16,
    });

    expect(result).toMatchObject({ ok: false, code: "invalid-range" });
  });

  test("serves an empty resource as a single zero-length chunk at its end", async () => {
    const { producer } = createProducer({
      files: [{ ...createTestDiffFile({ before: BEFORE, after: AFTER }), patch: "" }],
    });
    const fileKey = producer.getPublication().document.files[0]!.key;

    const result = await producer.readResource({
      generation: producer.getPublication().generation,
      resourceId: reviewResourceId({ kind: "patch", fileKey }),
      offset: 0,
      length: 16,
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.chunk).toMatchObject({ byteLength: 0, contentSize: 0, eof: true });
  });
});

describe("review producer source resources", () => {
  const withSource = (getFullText: (side: "old" | "new") => Promise<string | null>) =>
    createProducer({
      files: [
        createTestDiffFile({
          before: BEFORE,
          after: AFTER,
          sourceFetcher: { cacheKey: "src", getFullText },
        }),
      ],
    });

  test("serves the expandable side's full source text", async () => {
    const { producer } = withSource(async () => AFTER);
    const fileKey = producer.getPublication().document.files[0]!.key;

    const { text } = await readWhole(
      producer,
      reviewResourceId({ kind: "source", fileKey, side: "new" }),
    );

    expect(text).toBe(AFTER);
  });

  test("offers the old side for a deleted file, whose new side does not exist", () => {
    const { producer } = createProducer({
      files: [
        createTestDiffFile({
          before: BEFORE,
          after: "",
          sourceFetcher: { cacheKey: "src", getFullText: async () => BEFORE },
        }),
      ],
    });

    expect(producer.describeResources().filter((resource) => resource.kind === "source")).toEqual([
      expect.objectContaining({ kind: "source", side: "old" }),
    ]);
  });

  test("offers no source resource for a file with no reader behind it", () => {
    const { producer } = createProducer();
    const fileKey = producer.getPublication().document.files[0]!.key;

    expect(
      producer
        .describeResources()
        .some((resource) => resource.id.includes(`source:new:${fileKey}`)),
    ).toBe(false);
  });

  test("reports an unreadable side as unavailable rather than unknown", async () => {
    const { producer } = withSource(async () => null);
    const fileKey = producer.getPublication().document.files[0]!.key;

    const result = await producer.readResource({
      generation: producer.getPublication().generation,
      resourceId: reviewResourceId({ kind: "source", fileKey, side: "new" }),
      offset: 0,
      length: 16,
    });

    expect(result).toMatchObject({ ok: false, code: "resource-unavailable" });
  });

  test("reports a refusing reader and an oversized source as too large", async () => {
    for (const reader of [
      async () => {
        throw new SourceTextTooLargeError(10);
      },
      async () => "x".repeat(MAX_REVIEW_SOURCE_RESOURCE_BYTES + 1),
    ]) {
      const { producer } = withSource(reader as (side: "old" | "new") => Promise<string | null>);
      const fileKey = producer.getPublication().document.files[0]!.key;

      expect(
        await producer.readResource({
          generation: producer.getPublication().generation,
          resourceId: reviewResourceId({ kind: "source", fileKey, side: "new" }),
          offset: 0,
          length: 16,
        }),
      ).toMatchObject({ ok: false, code: "resource-too-large" });
    }
  });

  test("reports a thrown read as unavailable, carrying the reason", async () => {
    const { producer } = withSource(async () => {
      throw new Error("permission denied");
    });
    const fileKey = producer.getPublication().document.files[0]!.key;

    const result = await producer.readResource({
      generation: producer.getPublication().generation,
      resourceId: reviewResourceId({ kind: "source", fileKey, side: "new" }),
      offset: 0,
      length: 16,
    });

    expect(result).toMatchObject({ ok: false, code: "resource-unavailable" });
    expect(result.ok === false && result.message).toContain("permission denied");
  });
});

describe("review producer resource loading", () => {
  /** Build many files, each with a reader that records when it is running. */
  function createTrackedProducer(count: number, concurrency: number) {
    let running = 0;
    let peak = 0;
    const reads: string[] = [];
    const files = Array.from({ length: count }, (_unused, index) =>
      createTestDiffFile({
        id: `file-${index}`,
        path: `file-${index}.ts`,
        before: BEFORE,
        after: AFTER,
        sourceFetcher: {
          cacheKey: `src-${index}`,
          getFullText: async () => {
            reads.push(`file-${index}`);
            running += 1;
            peak = Math.max(peak, running);
            await Promise.resolve();
            await Promise.resolve();
            running -= 1;
            return AFTER;
          },
        },
      }),
    );
    return {
      reads,
      peak: () => peak,
      ...createProducer({ files, resourceConcurrency: concurrency }),
    };
  }

  test("never loads more resources at once than its concurrency limit", async () => {
    const tracked = createTrackedProducer(12, 3);
    const sourceIds = tracked.producer
      .describeResources()
      .filter((resource) => resource.kind === "source")
      .map((resource) => resource.id);

    const loaded = await tracked.producer.materializeResources(sourceIds);

    expect(loaded.size).toBe(12);
    expect(tracked.peak()).toBeLessThanOrEqual(3);
    expect(tracked.reads).toHaveLength(12);
  });

  // Intent: single flight is structural — concurrent readers share one production, and a
  // settled one is never produced again, so a double read is not reachable from outside.
  test("produces one resource once however many readers ask for it", async () => {
    const tracked = createTrackedProducer(1, 4);
    const sourceId = tracked.producer.describeResources().find((r) => r.kind === "source")!.id;
    const generation = tracked.producer.getPublication().generation;

    await Promise.all([
      tracked.producer.materializeResources([sourceId, sourceId, sourceId]),
      tracked.producer.readResource({ generation, resourceId: sourceId, offset: 0, length: 8 }),
    ]);
    await tracked.producer.readResource({ generation, resourceId: sourceId, offset: 8, length: 8 });

    expect(tracked.reads).toEqual(["file-0"]);
  });

  test("refuses a batch larger than one request may name", async () => {
    const { producer } = createProducer();
    const resourceId = producer.describeResources()[0]!.id;

    expect(
      producer.materializeResources(Array.from({ length: 513 }, () => resourceId)),
    ).rejects.toThrow(RangeError);
  });

  test("describes a resource with its measurements once it has been produced", async () => {
    const { producer } = createProducer();
    const resourceId = reviewResourceId({
      kind: "patch",
      fileKey: producer.getPublication().document.files[0]!.key,
    });

    const unmeasured = producer.describeResources().find((r) => r.id === resourceId)!;
    expect(unmeasured.byteLength).toBeUndefined();
    expect(unmeasured.digest).toBeUndefined();
    await producer.materializeResources([resourceId]);

    expect(producer.describeResources().find((r) => r.id === resourceId)).toMatchObject({
      byteLength: expect.any(Number),
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe("review producer intents", () => {
  test("supplies the annotation index annotated navigation needs", () => {
    const annotated = createTestDiffFile({
      id: "annotated",
      path: "annotated.ts",
      before: BEFORE,
      after: AFTER,
      agent: true,
    });
    const plain = createTestDiffFile({
      id: "plain",
      path: "plain.ts",
      before: BEFORE,
      after: AFTER,
    });
    const { producer } = createProducer({ files: [plain, annotated] });
    const store = createReviewStore(producer.getPublication().document);
    producer.attachStore(store);

    const outcome = producer.applyIntent({
      type: "selection/move",
      scope: "annotated-hunk",
      delta: 1,
    });

    expect(outcome).toMatchObject({
      type: "selection/changed",
      fileKey: producer.getPublication().document.files[1]!.key,
    });
  });

  test("refuses to plan an intent before a review state is attached", () => {
    const { producer } = createProducer();

    expect(() => producer.applyIntent({ type: "filter/set", filter: "x" })).toThrow(
      "no review state",
    );
  });
});

describe("parseReadReviewResourceRequest", () => {
  test("accepts exactly the request's fields", () => {
    const request = {
      generation: "generation:test:0",
      resourceId: "resource:patch:file:abc",
      offset: 0,
      length: 16,
    };
    expect(parseReadReviewResourceRequest(request)).toEqual(request);
    expect(parseReadReviewResourceRequest({ ...request, extra: 1 })).toBeUndefined();
    expect(parseReadReviewResourceRequest({ ...request, resourceId: "" })).toBeUndefined();
  });
});
