import { describe, expect, test } from "bun:test";
import { projectReviewDocument } from "../core/review/document";
import type { ReviewFileV1 } from "../core/review/types";
import { createTestDiffFile, createTestSourceFetcher } from "../../test/helpers/diff-helpers";
import { reviewErrorMessage } from "../session/reviewErrorCatalog";
import { reviewHttpFailure } from "../session/reviewHttpProtocol";
import type { ReviewClientResult } from "./reviewApiClient";
import { ReviewSourceStore, type ReviewSourceReader } from "./reviewSources";

const BASE = `${Array.from({ length: 12 }, (_unused, index) => `line ${index + 1}`).join("\n")}\n`;

/** One file a review would publish, with source the page can expand gaps from. */
function testFile(): ReviewFileV1 {
  return projectReviewDocument(
    [
      createTestDiffFile({
        id: "alpha",
        path: "src/alpha.ts",
        before: BASE,
        after: BASE.replace("line 4", "line 4 changed"),
        context: 1,
        // A file with a fetcher is one the review offers a source resource for.
        sourceFetcher: createTestSourceFetcher(() => BASE),
      }),
    ],
    { sourceLabel: "/repo" },
  ).files[0]!;
}

/** A reader a test resolves by hand, so a read can be left in flight. */
function createTestReader() {
  const requests: string[] = [];
  const pending: Array<(result: ReviewClientResult<Uint8Array>) => void> = [];
  const reader: ReviewSourceReader = {
    readResource(descriptor) {
      requests.push(descriptor.id);
      return new Promise<ReviewClientResult<Uint8Array>>((resolve) => {
        pending.push(resolve);
      });
    },
  };
  return {
    reader,
    requests,
    /** Answer the oldest read still waiting. */
    resolve(result: ReviewClientResult<Uint8Array>) {
      pending.shift()?.(result);
    },
  };
}

/** Let every already-resolved promise settle. */
async function settle() {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

describe("ReviewSourceStore", () => {
  test("keeps the text one read returned, for the file it was read for", async () => {
    const file = testFile();
    const { reader, resolve } = createTestReader();
    const store = new ReviewSourceStore(reader);
    store.setGeneration("generation:p1:0");

    store.request(file);
    expect(store.getSnapshot().entries[file.key]?.status).toBe("loading");
    resolve({ ok: true, value: new TextEncoder().encode(BASE) });
    await settle();

    expect(store.getSnapshot().entries[file.key]).toEqual({ status: "ready", text: BASE });
  });

  test("drops a read that lands after the review moved to another generation", async () => {
    const file = testFile();
    const { reader, resolve } = createTestReader();
    const store = new ReviewSourceStore(reader);
    store.setGeneration("generation:p1:0");
    store.request(file);

    // The review reloaded while the read was in flight: the same key over new content is
    // different text, and drawing it in the new generation's gaps would be wrong lines.
    store.setGeneration("generation:p1:1");
    resolve({ ok: true, value: new TextEncoder().encode(BASE) });
    await settle();

    expect(store.getSnapshot().entries[file.key]).toBeUndefined();
  });

  test("says which generation the text it holds was read for", async () => {
    const file = testFile();
    const { reader, resolve } = createTestReader();
    const store = new ReviewSourceStore(reader);
    store.setGeneration("generation:p1:0");
    store.request(file);
    resolve({ ok: true, value: new TextEncoder().encode(BASE) });
    await settle();

    expect(store.getSnapshot().generation).toBe("generation:p1:0");

    // A page renders the new generation's document before any effect can clear this store,
    // so what it holds has to say which review it belongs to.
    store.setGeneration("generation:p1:1");

    expect(store.getSnapshot()).toEqual({ generation: "generation:p1:1", entries: {} });
  });

  test("reads a file's source once, however many gaps in it are opened", async () => {
    const file = testFile();
    const { reader, requests, resolve } = createTestReader();
    const store = new ReviewSourceStore(reader);
    store.setGeneration("generation:p1:0");

    store.request(file);
    // Asked again while the first read is still in flight, then again once it is held.
    store.request(file);
    resolve({ ok: true, value: new TextEncoder().encode(BASE) });
    await settle();
    store.request(file);
    await settle();

    expect(requests).toHaveLength(1);
  });

  test("remembers why a read was refused, in the catalog's words", async () => {
    const file = testFile();
    const { reader, resolve } = createTestReader();
    const store = new ReviewSourceStore(reader);
    store.setGeneration("generation:p1:0");

    store.request(file);
    resolve(reviewHttpFailure("resource-unavailable"));
    await settle();

    expect(store.getSnapshot().entries[file.key]).toMatchObject({
      status: "failed",
      failure: {
        code: "resource-unavailable",
        message: reviewErrorMessage("resource-unavailable"),
      },
    });
  });

  test("reads again after a failure, since asking again is the reader's retry", async () => {
    const file = testFile();
    const { reader, requests, resolve } = createTestReader();
    const store = new ReviewSourceStore(reader);
    store.setGeneration("generation:p1:0");

    store.request(file);
    resolve(reviewHttpFailure("resource-unavailable"));
    await settle();
    store.request(file);
    resolve({ ok: true, value: new TextEncoder().encode(BASE) });
    await settle();

    expect(requests).toHaveLength(2);
    expect(store.getSnapshot().entries[file.key]).toEqual({ status: "ready", text: BASE });
  });

  test("tells watchers when a file's source state changes", async () => {
    const file = testFile();
    const { reader, resolve } = createTestReader();
    const store = new ReviewSourceStore(reader);
    store.setGeneration("generation:p1:0");
    let notices = 0;
    store.subscribe(() => {
      notices += 1;
    });

    store.request(file);
    resolve({ ok: true, value: new TextEncoder().encode(BASE) });
    await settle();

    expect(notices).toBe(2);
  });
});
