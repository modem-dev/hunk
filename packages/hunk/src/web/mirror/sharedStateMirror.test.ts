import { describe, expect, test } from "bun:test";
import type {
  HunkReviewPublicationBodyV1,
  HunkReviewStateBodyV1,
} from "../../session/reviewHttpProtocol";
import type { ReviewSharedStateV1 } from "../../session/reviewSharedState";
import type { ReviewApiClient } from "../transport/apiClient";
import { ReviewApiError } from "../transport/apiClient";
import {
  ReviewSharedStateMirror,
  reviewPublicationNeedsState,
  reviewStateBodySupersedes,
} from "./sharedStateMirror";

const FIRST = "generation:p1:1";
const SECOND = "generation:p1:2";

/** A publication at one position, optionally stating its shared revision. */
function createTestPublication(
  generation: string,
  stateRevision: number,
  sharedStateRevision?: number,
): HunkReviewPublicationBodyV1 {
  return {
    protocolVersion: 1,
    sessionId: "s",
    publication: { generation, stateRevision },
    ...(sharedStateRevision !== undefined ? { sharedStateRevision } : {}),
    catalog: { generation, resources: [] },
  } as unknown as HunkReviewPublicationBodyV1;
}

/** A state body at one position and shared revision. */
function createTestStateBody(
  generation: string,
  sharedStateRevision: number,
  stateRevision = 0,
): HunkReviewStateBodyV1 {
  return {
    protocolVersion: 1,
    sessionId: "s",
    publication: { generation, stateRevision },
    sharedStateRevision,
    state: { generation, sharedStateRevision } as unknown as ReviewSharedStateV1,
  };
}

/** A client whose state reads answer from a queue the test controls. */
function createTestClient() {
  const pending: Array<{
    resolve: (body: HunkReviewStateBodyV1) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
  }> = [];
  const client = {
    state: (signal?: AbortSignal) =>
      new Promise<HunkReviewStateBodyV1>((resolve, reject) => {
        pending.push({ resolve, reject, signal });
      }),
  } as unknown as ReviewApiClient;
  return { client, pending };
}

describe("shared-state ordering", () => {
  test("refetches for a new generation or an advanced shared revision only", () => {
    const shown = createTestStateBody(FIRST, 4);
    expect(reviewPublicationNeedsState(undefined, createTestPublication(FIRST, 0))).toBe(true);
    // A selection moving elsewhere advances the state revision but not the shared one.
    expect(reviewPublicationNeedsState(shown, createTestPublication(FIRST, 9, 4))).toBe(false);
    expect(reviewPublicationNeedsState(shown, createTestPublication(FIRST, 9))).toBe(false);
    expect(reviewPublicationNeedsState(shown, createTestPublication(FIRST, 9, 5))).toBe(true);
    expect(reviewPublicationNeedsState(shown, createTestPublication(SECOND, 0, 0))).toBe(true);
    expect(reviewPublicationNeedsState(shown, createTestPublication("generation:p1:0", 0, 9))).toBe(
      false,
    );
  });

  test("accepts a body only when it is newer than the one shown", () => {
    const shown = createTestStateBody(FIRST, 4);
    expect(reviewStateBodySupersedes(undefined, shown)).toBe(true);
    expect(reviewStateBodySupersedes(shown, createTestStateBody(FIRST, 4, 7))).toBe(false);
    expect(reviewStateBodySupersedes(shown, createTestStateBody(FIRST, 5))).toBe(true);
    expect(reviewStateBodySupersedes(shown, createTestStateBody(SECOND, 0))).toBe(true);
    expect(reviewStateBodySupersedes(shown, createTestStateBody("generation:p2:9", 9))).toBe(false);
  });
});

describe("ReviewSharedStateMirror", () => {
  test("fetches once per position and lets a newer request supersede an older one", async () => {
    const { client, pending } = createTestClient();
    const mirror = new ReviewSharedStateMirror({ client });

    mirror.observe(createTestPublication(FIRST, 0, 1));
    mirror.observe(createTestPublication(FIRST, 1, 1));
    expect(pending).toHaveLength(1);

    mirror.observe(createTestPublication(FIRST, 2, 2));
    expect(pending).toHaveLength(2);
    expect(pending[0]!.signal?.aborted).toBe(true);

    pending[1]!.resolve(createTestStateBody(FIRST, 2));
    await Bun.sleep(0);
    expect(mirror.getSnapshot().body?.sharedStateRevision).toBe(2);
    // A late answer to the superseded request changes nothing.
    pending[0]!.resolve(createTestStateBody(FIRST, 1));
    await Bun.sleep(0);
    expect(mirror.getSnapshot().body?.sharedStateRevision).toBe(2);
  });

  test("hands the file mirror a generation's state, or nothing when it cannot be read", async () => {
    const { client, pending } = createTestClient();
    const mirror = new ReviewSharedStateMirror({ client });

    mirror.observe(createTestPublication(FIRST, 0, 0));
    const waiting = mirror.forGeneration(FIRST);
    pending[0]!.resolve(createTestStateBody(FIRST, 0));
    expect((await waiting)?.generation).toBe(FIRST);

    mirror.observe(createTestPublication(SECOND, 0, 0));
    const failing = mirror.forGeneration(SECOND);
    pending[1]!.reject(new ReviewApiError("state-too-large", "too large"));
    expect(await failing).toBeUndefined();
    expect(mirror.getSnapshot().error?.code).toBe("state-too-large");
    expect(mirror.getSnapshot().body?.publication.generation).toBe(FIRST);
  });

  test("resolves a waiter with nothing once a later generation arrives instead", async () => {
    const { client, pending } = createTestClient();
    const mirror = new ReviewSharedStateMirror({ client });

    mirror.observe(createTestPublication(FIRST, 0, 0));
    const waiting = mirror.forGeneration(FIRST);
    // The route always answers with the current state, which is already the next generation.
    pending[0]!.resolve(createTestStateBody(SECOND, 0));
    expect(await waiting).toBeUndefined();
    mirror.close();
  });
});
