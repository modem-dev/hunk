import { afterEach, describe, expect, test } from "bun:test";
import { reviewGapSourceForFile, reviewLeadingGap } from "../../core/review/expansion";
import {
  createTestDiffFile,
  createTestSourceFetcher,
} from "../../../../../test/helpers/diff-helpers";
import { serveTestWebReview } from "../../../../../test/helpers/web-review-server";
import type { ReviewSharedNoteV1, ReviewSharedStateV1 } from "../../session/reviewSharedState";
import { ReviewMirror } from "../mirror/reviewMirror";
import { createTestReviewDocument } from "../../../../../test/helpers/review-store-helpers";
import type { HunkReviewResourceCatalogV1 } from "../../session/reviewProtocol";
import type { ReviewApiClient } from "../transport/apiClient";
import { ClientReviewStore, isLocalReviewIntent } from "./clientReviewStore";

const running: Array<() => void> = [];

afterEach(() => {
  for (const stop of running.splice(0)) stop();
});

const BEFORE = Array.from({ length: 30 }, (_unused, index) => `const line${index} = ${index};`);
const AFTER = BEFORE.map((line, index) => (index === 20 ? "const line20 = 2000;" : line));

/** A file with a collapsed gap before its hunk and a source reader behind it. */
function createTestGapFile(id: string, source = AFTER.join("\n") + "\n", attested = false) {
  const sourceFetcher = createTestSourceFetcher((side) =>
    side === "new" ? source : BEFORE.join("\n"),
  );
  return createTestDiffFile({
    id,
    path: `src/${id}.ts`,
    before: BEFORE.join("\n") + "\n",
    after: AFTER.join("\n") + "\n",
    context: 2,
    // A cache key attests the reader's snapshot, so its status may survive a reload.
    sourceFetcher: attested
      ? Object.assign(sourceFetcher, { cacheKey: `${id}:new` })
      : sourceFetcher,
  });
}

/** Serve files, load them through a real mirror, and adopt them into a store. */
async function loadTestStore(files = [createTestGapFile("alpha"), createTestGapFile("beta")]) {
  const served = serveTestWebReview(files);
  running.push(served.stop);
  const client = served.client();
  const mirror = new ReviewMirror({ client, scheduleNotify: (flush) => flush() });
  running.push(() => mirror.close());
  mirror.observe(await client.publication());
  for (let attempt = 0; attempt < 400 && mirror.getSnapshot().status !== "ready"; attempt += 1) {
    await Bun.sleep(5);
  }
  const review = new ClientReviewStore({ client });
  running.push(() => review.close());
  review.adopt(mirror.getSnapshot().document, mirror.getSnapshot().catalog);
  return { served, client, mirror, review };
}

/** One live agent note on a file's first changed line, as a shared-state snapshot lists it. */
function createTestLiveNote(id: string, fileKey: string): ReviewSharedNoteV1 {
  return {
    origin: "live",
    resolution: "active",
    note: {
      id,
      source: "agent",
      fileKey,
      anchor: { newRange: [21, 21], intersectingHunkIndices: [0], ownerHunkIndex: 0 },
      summary: id,
      editable: false,
    },
  };
}

/** The first file's leading gap id. */
function leadingGapId(review: ClientReviewStore) {
  const file = review.store.getSnapshot().document.files[0]!;
  const gap = reviewLeadingGap(reviewGapSourceForFile(file), 0)!;
  return { fileKey: file.key, gapId: `${gap.position}:${gap.hunkIndex}` };
}

describe("ClientReviewStore", () => {
  test("selects the first file when a document arrives, without moving the viewport", async () => {
    const { review } = await loadTestStore();
    const state = review.store.getSnapshot();

    expect(state.selection.fileKey).toBe(state.document.files[0]!.key);
    expect(state.reveal).toEqual({ fileTopToken: 0, hunkToken: 0, scrollToNote: false });
  });

  test("applies selection intents locally through the shared planner", async () => {
    const { review, served } = await loadTestStore();
    const second = review.store.getSnapshot().document.files[1]!;
    const before = served.requests.length;

    review.apply({
      type: "selection/select-file",
      fileKey: second.key,
      reveal: { anchor: "file-top", scrollToNote: false },
    });

    expect(review.store.getSnapshot().selection.fileKey).toBe(second.key);
    expect(review.store.getSnapshot().reveal.fileTopToken).toBe(1);
    // Nothing was sent: selection is this page's alone.
    expect(served.requests.length).toBe(before);
  });

  test("walks file navigation past the files this page hides", async () => {
    const { review } = await loadTestStore([
      createTestGapFile("alpha"),
      createTestGapFile("beta"),
      createTestGapFile("gamma"),
    ]);
    const [alpha, beta, gamma] = review.store.getSnapshot().document.files;

    review.setHiddenFiles(new Set([beta!.key]));
    review.apply({ type: "selection/move", scope: "file", delta: 1 });
    expect(review.store.getSnapshot().selection.fileKey).toBe(gamma!.key);

    review.setHiddenFiles(new Set());
    review.apply({ type: "selection/move", scope: "file", delta: -1 });
    expect(review.store.getSnapshot().selection.fileKey).toBe(beta!.key);
    expect(alpha).toBeDefined();
  });

  // Intent: hiding the selected file (marking it viewed with "Hide viewed" on) must not leave
  // the reader on a file navigation cannot step from: the selection moves to the next shown
  // file, else the previous one, without scrolling, and stays put when nothing is shown.
  test("moves a selection whose file becomes hidden to the nearest shown file", async () => {
    const { review } = await loadTestStore([
      createTestGapFile("alpha"),
      createTestGapFile("beta"),
      createTestGapFile("gamma"),
    ]);
    const [alpha, beta, gamma] = review.store.getSnapshot().document.files;
    const selected = () => review.store.getSnapshot().selection.fileKey;
    review.apply({ type: "selection/select-file", fileKey: beta!.key });
    const reveal = review.store.getSnapshot().reveal;

    review.setHiddenFiles(new Set([beta!.key]));
    expect(selected()).toBe(gamma!.key);
    expect(review.store.getSnapshot().reveal).toEqual(reveal);
    review.apply({ type: "selection/move", scope: "file", delta: -1 });
    expect(selected()).toBe(alpha!.key);

    review.apply({ type: "selection/select-file", fileKey: gamma!.key });
    review.setHiddenFiles(new Set([beta!.key, gamma!.key]));
    expect(selected()).toBe(alpha!.key);

    review.setHiddenFiles(new Set([alpha!.key, beta!.key, gamma!.key]));
    expect(selected()).toBe(alpha!.key);
  });

  test("refuses shared intents, which this page does not author yet", async () => {
    const { review } = await loadTestStore();

    expect(isLocalReviewIntent({ type: "filter/set", filter: "x" })).toBe(false);
    expect(() => review.apply({ type: "filter/set", filter: "x" } as never)).toThrow(
      "not page-local",
    );
  });

  // Intent: every shared-state snapshot replaces the stored notes; the reader's active note
  // survives that while the snapshot still lists it, and goes only when the note does.
  test("keeps the active note across a snapshot that still has it", async () => {
    const { review } = await loadTestStore();
    const fileKey = review.store.getSnapshot().document.files[0]!.key;
    const first = createTestLiveNote("live:1", fileKey);
    const second = createTestLiveNote("live:2", fileKey);
    // Only the fields the store adopts; the rest of a snapshot is presentation.
    const snapshot = (notes: ReviewSharedNoteV1[], revision: number) =>
      ({
        sharedStateRevision: revision,
        files: [],
        notes,
        filter: "",
        showAgentNotes: true,
      }) as unknown as ReviewSharedStateV1;
    review.adoptShared(snapshot([first], 1));
    review.store.dispatch({
      type: "selection/select",
      fileKey,
      hunkIndex: 0,
      activeNoteId: "live:1",
    });

    review.adoptShared(snapshot([first, second], 2));
    expect(review.store.getSnapshot().activeNoteId).toBe("live:1");

    review.adoptShared(snapshot([second], 3));
    expect(review.store.getSnapshot().activeNoteId).toBeNull();
  });

  test("expands a gap and loads its source into the shared status vocabulary", async () => {
    const { review } = await loadTestStore();
    const { fileKey, gapId } = leadingGapId(review);

    const outcome = review.apply({ type: "expansion/toggle", fileKey, gapId });
    expect(outcome).toMatchObject({ type: "expansion/toggled", expanded: true });
    expect(review.store.getSnapshot().sourceStatusByFileKey[fileKey]).toEqual({ kind: "loading" });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (review.store.getSnapshot().sourceStatusByFileKey[fileKey]?.kind !== "loading") break;
      await Bun.sleep(5);
    }

    expect(review.store.getSnapshot().sourceStatusByFileKey[fileKey]).toEqual({
      kind: "loaded",
      text: AFTER.join("\n") + "\n",
    });
  });

  test("keeps selection and expansion across a reload of unchanged content", async () => {
    const { review, served, client, mirror } = await loadTestStore();
    const { fileKey, gapId } = leadingGapId(review);
    const second = review.store.getSnapshot().document.files[1]!;
    review.apply({ type: "expansion/toggle", fileKey, gapId });
    review.apply({
      type: "selection/select-file",
      fileKey: second.key,
      reveal: { anchor: "none", scrollToNote: false },
    });
    const registration = served.harness.register();
    served.harness.producer.publish({
      files: [createTestGapFile("alpha"), createTestGapFile("beta")],
      sourceLabel: "/repo",
    });
    served.harness.register(registration);

    const previousGeneration = mirror.getSnapshot().address?.generation;
    mirror.observe(await client.publication());
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const snapshot = mirror.getSnapshot();
      if (snapshot.address?.generation !== previousGeneration && !snapshot.updating) break;
      await Bun.sleep(5);
    }
    expect(mirror.getSnapshot().address?.generation).not.toBe(previousGeneration);
    review.adopt(mirror.getSnapshot().document, mirror.getSnapshot().catalog);

    const state = review.store.getSnapshot();
    expect(state.selection.fileKey).toBe(second.key);
    expect(state.expandedGaps).toEqual([{ fileKey, gapId, expanded: true }]);
  });

  // Intent: a reload that aborts a source read in flight must not leave the gap loading
  // forever; the read restarts against the new generation's catalog.
  test.each([false, true])(
    "restarts a source read a reload aborted (attested %p)",
    async (attested) => {
      const files = () => [
        createTestGapFile("alpha", undefined, attested),
        createTestGapFile("beta", undefined, attested),
      ];
      const { review, served, client, mirror } = await loadTestStore(files());
      const { fileKey, gapId } = leadingGapId(review);
      const registration = served.harness.register();
      served.harness.producer.publish({ files: files(), sourceLabel: "/repo" });
      served.harness.register(registration);
      const previousGeneration = mirror.getSnapshot().address?.generation;
      mirror.observe(await client.publication());
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const snapshot = mirror.getSnapshot();
        if (snapshot.address?.generation !== previousGeneration && !snapshot.updating) break;
        await Bun.sleep(5);
      }

      // The read starts against the old catalog and the reload lands before it can finish.
      review.apply({ type: "expansion/toggle", fileKey, gapId });
      review.adopt(mirror.getSnapshot().document, mirror.getSnapshot().catalog);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (review.store.getSnapshot().sourceStatusByFileKey[fileKey]?.kind !== "loading") break;
        await Bun.sleep(5);
      }

      expect(review.store.getSnapshot().sourceStatusByFileKey[fileKey]).toEqual({
        kind: "loaded",
        text: AFTER.join("\n") + "\n",
      });
    },
  );

  // Intent: when a second source read starts for one file (a same-generation reload dropped
  // the first one's status), the first is aborted and its slower answer never lands.
  test("aborts a superseded source read and ignores its answer", async () => {
    const reads: Array<{ resolve: (text: string) => void; signal: AbortSignal }> = [];
    const client = {
      readResource: (_descriptor: unknown, signal: AbortSignal) =>
        new Promise<Uint8Array>((resolve) => {
          reads.push({ resolve: (text) => resolve(new TextEncoder().encode(text)), signal });
        }),
    } as unknown as ReviewApiClient;
    const review = new ClientReviewStore({ client });
    const document = createTestReviewDocument(["alpha"]);
    const fileKey = document.files[0]!.key;
    const catalog = {
      generation: "g1",
      resources: [{ kind: "source", fileKey, id: "source:alpha", generation: "g1" }],
    } as unknown as HunkReviewResourceCatalogV1;
    review.adopt(document, catalog);

    void review.loadSource(fileKey);
    // A reload of the same generation drops the unattested status while the read runs.
    review.adopt({ files: [...document.files] }, catalog);
    void review.loadSource(fileKey);
    expect(reads).toHaveLength(2);
    expect(reads[0]!.signal.aborted).toBe(true);

    reads[1]!.resolve("new text");
    await Bun.sleep(0);
    reads[0]!.resolve("old text");
    await Bun.sleep(0);

    expect(review.store.getSnapshot().sourceStatusByFileKey[fileKey]).toEqual({
      kind: "loaded",
      text: "new text",
    });
  });
});
