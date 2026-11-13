import { afterEach, describe, expect, test } from "bun:test";
import { reviewGapSourceForFile, reviewLeadingGap } from "../../core/review/expansion";
import {
  createTestDiffFile,
  createTestSourceFetcher,
} from "../../../../../test/helpers/diff-helpers";
import { serveTestWebReview } from "../../../../../test/helpers/web-review-server";
import { ReviewMirror } from "../mirror/reviewMirror";
import { ClientReviewStore, isLocalReviewIntent } from "./clientReviewStore";

const running: Array<() => void> = [];

afterEach(() => {
  for (const stop of running.splice(0)) stop();
});

const BEFORE = Array.from({ length: 30 }, (_unused, index) => `const line${index} = ${index};`);
const AFTER = BEFORE.map((line, index) => (index === 20 ? "const line20 = 2000;" : line));

/** A file with a collapsed gap before its hunk and a source reader behind it. */
function createTestGapFile(id: string, source = AFTER.join("\n") + "\n") {
  return createTestDiffFile({
    id,
    path: `src/${id}.ts`,
    before: BEFORE.join("\n") + "\n",
    after: AFTER.join("\n") + "\n",
    context: 2,
    sourceFetcher: createTestSourceFetcher((side) => (side === "new" ? source : BEFORE.join("\n"))),
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

  test("refuses shared intents, which this page does not author yet", async () => {
    const { review } = await loadTestStore();

    expect(isLocalReviewIntent({ type: "filter/set", filter: "x" })).toBe(false);
    expect(() => review.apply({ type: "filter/set", filter: "x" } as never)).toThrow(
      "not page-local",
    );
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
});
