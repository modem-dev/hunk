import { describe, expect, test } from "bun:test";
import {
  createTestReviewDocument,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import { createReviewStore } from "./store";

describe("createReviewStore", () => {
  test("publishes a new snapshot for every state-changing dispatch", () => {
    const store = createReviewStore(createTestReviewDocument(["alpha", "beta"]));
    const snapshots: number[] = [];
    store.subscribe(() => snapshots.push(store.getSnapshot().stateRevision));

    store.dispatch({ type: "filter/set", filter: "alpha" });
    store.dispatch({ type: "notes/set-visibility", visible: true });

    expect(snapshots).toEqual([1, 2]);
    expect(store.getSnapshot().filter).toBe("alpha");
  });

  test("keeps the snapshot identical when an action changes nothing", () => {
    const store = createReviewStore(createTestReviewDocument(["alpha"]));
    const before = store.getSnapshot();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    const result = store.dispatch({ type: "filter/set", filter: "" });

    expect(result).toBe(before);
    expect(notified).toBe(0);
  });

  test("returns the state the caller just produced", () => {
    const store = createReviewStore(createTestReviewDocument(["alpha"]));

    const next = store.dispatch({
      type: "notes/add-live",
      notes: [createTestStoredNote({ id: "live-1", fileKey: "alpha" })],
    });

    expect(next).toBe(store.getSnapshot());
    expect(next.liveNotes).toHaveLength(1);
  });

  test("stops notifying an unsubscribed listener", () => {
    const store = createReviewStore(createTestReviewDocument(["alpha"]));
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    store.dispatch({ type: "filter/set", filter: "a" });
    unsubscribe();
    store.dispatch({ type: "filter/set", filter: "ab" });

    expect(notified).toBe(1);
  });

  test("tolerates a listener unsubscribing while it is being notified", () => {
    const store = createReviewStore(createTestReviewDocument(["alpha"]));
    const seen: string[] = [];
    const unsubscribeFirst = store.subscribe(() => {
      seen.push("first");
      unsubscribeFirst();
    });
    store.subscribe(() => seen.push("second"));

    store.dispatch({ type: "filter/set", filter: "a" });

    expect(seen).toEqual(["first", "second"]);
  });
});
