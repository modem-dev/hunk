import { describe, expect, test } from "bun:test";
import { projectReviewDocument } from "../core/review/document";
import type { ReviewPublicationAddress } from "../core/review/generationOrder";
import { reviewResourceId } from "../core/review/resources";
import type { ReviewFileV1 } from "../core/review/types";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import {
  HUNK_REVIEW_PROTOCOL_VERSION,
  type HunkReviewResourceCatalogV1,
} from "../session/reviewProtocol";
import { reviewHttpFailure, type HunkReviewPublicationBodyV1 } from "../session/reviewHttpProtocol";
import type { ReviewClientResult, ReviewEventHandlers } from "./reviewApiClient";
import { ReviewMirror, type ReviewMirrorSnapshot, type ReviewMirrorSource } from "./reviewMirror";

const SESSION_ID = "session-1";

/** Project real files, so what the mirror parses is what a producer would have served. */
function documentFor(paths: string[]): ReviewFileV1[] {
  return projectReviewDocument(
    paths.map((path, index) => createTestDiffFile({ id: `file-${index}`, path })),
    { sourceLabel: "/repo" },
  ).files;
}

/** The catalog one generation of those files publishes, in review order. */
function catalogFor(generation: string, files: ReviewFileV1[]): HunkReviewResourceCatalogV1 {
  return {
    generation,
    fileKeysByRuntimeId: Object.fromEntries(files.map((file) => [file.runtimeId, file.key])),
    resources: files.flatMap((file) => [
      {
        id: reviewResourceId({ kind: "canonical-file", fileKey: file.key }),
        generation,
        fileKey: file.key,
        kind: "canonical-file" as const,
        contentType: "application/vnd.hunk.review-file+json; charset=utf-8" as const,
      },
      {
        id: reviewResourceId({ kind: "patch", fileKey: file.key }),
        generation,
        fileKey: file.key,
        kind: "patch" as const,
        contentType: "text/x-diff; charset=utf-8" as const,
      },
    ]),
  };
}

function publicationFor(
  address: ReviewPublicationAddress,
  files: ReviewFileV1[],
): HunkReviewPublicationBodyV1 {
  return {
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    publication: address,
    catalog: catalogFor(address.generation, files),
  };
}

/**
 * A transport a test drives by hand.
 *
 * The stream is a handle rather than a promise so a test can deliver publications in the
 * order it wants to reason about, which is what the ordering rules are all about.
 */
function createTestSource() {
  const encoder = new TextEncoder();
  const filesByKey = new Map<string, ReviewFileV1>();
  const reads: string[] = [];
  let handlers: ReviewEventHandlers | undefined;
  let endStream: (() => void) | undefined;
  let pendingRead: (() => void) | undefined;
  let holdReads = false;
  let streams = 0;

  const source: ReviewMirrorSource = {
    async readResource(descriptor): Promise<ReviewClientResult<Uint8Array>> {
      reads.push(descriptor.id);
      if (holdReads) {
        await new Promise<void>((resolve) => {
          pendingRead = resolve;
        });
      }
      const file = [...filesByKey.values()].find(
        (candidate) =>
          reviewResourceId({ kind: "canonical-file", fileKey: candidate.key }) === descriptor.id,
      );
      return file
        ? { ok: true, value: encoder.encode(JSON.stringify(file)) }
        : reviewHttpFailure("unknown-resource");
    },
    streamEvents(next, signal) {
      streams += 1;
      handlers = next;
      return new Promise<void>((resolve) => {
        endStream = resolve;
        // A detached stream really ends, the way an aborted `fetch` body does, so a test
        // cannot keep delivering events to a mirror that stopped listening.
        signal?.addEventListener("abort", () => {
          handlers = undefined;
          resolve();
        });
      });
    },
  };

  return {
    source,
    reads,
    /** How many streams the mirror has opened. */
    streamCount: () => streams,
    /** Make one generation's files readable. */
    offer(files: ReviewFileV1[]) {
      for (const file of files) {
        filesByKey.set(file.key, file);
      }
    },
    publish(body: HunkReviewPublicationBodyV1) {
      handlers?.onPublication(body);
    },
    disconnect() {
      handlers?.onDisconnect?.();
    },
    /** Drop the stream the way the real client does: an error, then the read ending. */
    dropStream() {
      handlers?.onError?.(reviewHttpFailure("resource-unavailable"));
      handlers = undefined;
      endStream?.();
      endStream = undefined;
    },
    /** Stall every resource read until `releaseReads` is called. */
    holdReads() {
      holdReads = true;
    },
    releaseReads() {
      holdReads = false;
      pendingRead?.();
      pendingRead = undefined;
    },
    end() {
      endStream?.();
    },
  };
}

/** Let every already-resolved promise settle. */
async function settle() {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

/**
 * Timers a test runs by hand.
 *
 * A reconnect never fires on its own — no ordering assertion has one running underneath it —
 * and a test that is about reconnecting calls `reconnectNow` to run the one that is pending.
 */
function createTestTimers() {
  let due: (() => void) | undefined;
  return {
    timers: {
      setTimeout: (handler: () => void) => {
        due = handler;
        return 1;
      },
      clearTimeout: () => {
        due = undefined;
      },
    },
    reconnectNow() {
      const handler = due;
      due = undefined;
      handler?.();
    },
  };
}

function createMirror() {
  const transport = createTestSource();
  const { timers, reconnectNow } = createTestTimers();
  const mirror = new ReviewMirror(transport.source, { timers });
  const seen: ReviewMirrorSnapshot[] = [];
  mirror.subscribe((snapshot) => seen.push(snapshot));
  return { ...transport, mirror, seen, reconnectNow };
}

describe("ReviewMirror", () => {
  test("loads the document the first publication describes, in review order", async () => {
    const files = documentFor(["src/alpha.ts", "src/beta.ts"]);
    const harness = createMirror();
    harness.offer(files);

    harness.mirror.start();
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, files));
    await settle();

    expect(harness.mirror.getSnapshot().status).toBe("ready");
    expect(harness.mirror.getSnapshot().document?.files.map((file) => file.path)).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
    ]);
    // Only canonical files are read: the patch is carried inside one.
    expect(harness.reads.every((id) => id.startsWith("resource:canonical-file:"))).toBe(true);
  });

  test("advances the position without re-reading a generation it already holds", async () => {
    const files = documentFor(["src/alpha.ts"]);
    const harness = createMirror();
    harness.offer(files);
    harness.mirror.start();
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, files));
    await settle();
    const readsAfterLoad = harness.reads.length;

    // Revisions need not be contiguous — a receiver legitimately sees jumps — which is the
    // rule the prototype's client got wrong.
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 9 }, files));
    await settle();

    expect(harness.mirror.getSnapshot().publication).toEqual({
      generation: "generation:p1:0",
      stateRevision: 9,
    });
    expect(harness.reads).toHaveLength(readsAfterLoad);
  });

  test("ignores a publication behind the one it holds", async () => {
    const files = documentFor(["src/alpha.ts"]);
    const harness = createMirror();
    harness.offer(files);
    harness.mirror.start();
    harness.publish(publicationFor({ generation: "generation:p1:1", stateRevision: 4 }, files));
    await settle();

    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 9 }, files));
    harness.publish(publicationFor({ generation: "generation:p1:1", stateRevision: 4 }, files));
    await settle();

    expect(harness.mirror.getSnapshot().publication).toEqual({
      generation: "generation:p1:1",
      stateRevision: 4,
    });
  });

  test("resyncs onto a later generation and drops what the older one was loading", async () => {
    const first = documentFor(["src/alpha.ts"]);
    const second = documentFor(["src/gamma.ts"]);
    const harness = createMirror();
    harness.offer([...first, ...second]);
    harness.mirror.start();
    harness.holdReads();
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, first));
    await settle();

    // The newer generation arrives while the older one is still reading its files.
    harness.publish(publicationFor({ generation: "generation:p1:1", stateRevision: 1 }, second));
    harness.releaseReads();
    await settle();

    expect(harness.mirror.getSnapshot().status).toBe("ready");
    expect(harness.mirror.getSnapshot().publication?.generation).toBe("generation:p1:1");
    expect(harness.mirror.getSnapshot().document?.files.map((file) => file.path)).toEqual([
      "src/gamma.ts",
    ]);
  });

  test("reports a file it cannot read, keeping the failure's own code", async () => {
    const files = documentFor(["src/alpha.ts"]);
    const harness = createMirror();

    harness.mirror.start();
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, files));
    await settle();

    expect(harness.mirror.getSnapshot()).toMatchObject({
      status: "failed",
      failure: { code: "unknown-resource" },
    });
  });

  test("refuses a file whose content does not hash to the identity it declares", async () => {
    const files = documentFor(["src/alpha.ts"]);
    const harness = createMirror();
    // Exactly the D4 failure: a file that arrives describing content it is not.
    harness.offer([{ ...files[0]!, path: "src/tampered.ts" }]);

    harness.mirror.start();
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, files));
    await settle();

    expect(harness.mirror.getSnapshot()).toMatchObject({
      status: "failed",
      failure: { code: "resource-integrity" },
    });
  });

  test("reads the document again when the publication that failed is delivered again", async () => {
    const files = documentFor(["src/alpha.ts"]);
    const harness = createMirror();
    // Nothing is readable yet, so the first load fails the way a transient refusal does.
    harness.mirror.start();
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, files));
    await settle();
    expect(harness.mirror.getSnapshot().status).toBe("failed");

    harness.offer(files);
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, files));
    await settle();

    expect(harness.mirror.getSnapshot().status).toBe("ready");
    expect(harness.mirror.getSnapshot().document?.files).toHaveLength(1);
    expect(harness.mirror.getSnapshot().failure).toBeUndefined();
  });

  test("keeps the document a dropped stream did not invalidate, and recovers when it resyncs", async () => {
    const files = documentFor(["src/alpha.ts"]);
    const harness = createMirror();
    harness.offer(files);
    harness.mirror.start();
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, files));
    await settle();
    const readsAfterLoad = harness.reads.length;

    harness.dropStream();
    await settle();

    // The link is gone, not the review: the diff stays on screen while the retry is pending.
    expect(harness.mirror.getSnapshot().status).toBe("reconnecting");
    expect(harness.mirror.getSnapshot().document?.files).toHaveLength(1);

    harness.reconnectNow();
    await settle();
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, files));
    await settle();

    expect(harness.mirror.getSnapshot().status).toBe("ready");
    expect(harness.mirror.getSnapshot().failure).toBeUndefined();
    // The generation is immutable, so the resync confirmed the document rather than re-read it.
    expect(harness.reads).toHaveLength(readsAfterLoad);
  });

  test("never moves the position back to where a finished load started", async () => {
    const files = documentFor(["src/alpha.ts"]);
    const harness = createMirror();
    harness.offer(files);
    harness.mirror.start();
    harness.holdReads();
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, files));
    await settle();

    // The review moves on within the generation while its document is still being read.
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 2 }, files));
    harness.releaseReads();
    await settle();

    expect(harness.mirror.getSnapshot().status).toBe("ready");
    expect(harness.mirror.getSnapshot().publication).toEqual({
      generation: "generation:p1:0",
      stateRevision: 2,
    });
  });

  test("attaches again after it was detached, so a remounted view is not left dead", async () => {
    const files = documentFor(["src/alpha.ts"]);
    const harness = createMirror();
    harness.offer(files);

    harness.mirror.start();
    harness.mirror.stop();
    await settle();
    harness.mirror.start();
    await settle();
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, files));
    await settle();

    expect(harness.streamCount()).toBe(2);
    expect(harness.mirror.getSnapshot().status).toBe("ready");
    expect(harness.mirror.getSnapshot().document?.files).toHaveLength(1);
  });

  test("stops for good when the session says goodbye", async () => {
    const files = documentFor(["src/alpha.ts"]);
    const harness = createMirror();
    harness.offer(files);
    harness.mirror.start();
    harness.publish(publicationFor({ generation: "generation:p1:0", stateRevision: 1 }, files));
    await settle();

    harness.disconnect();
    harness.end();
    await settle();

    expect(harness.mirror.getSnapshot().status).toBe("disconnected");
    // The document stays on screen: the session is gone, not the review it published.
    expect(harness.mirror.getSnapshot().document?.files).toHaveLength(1);
  });
});
