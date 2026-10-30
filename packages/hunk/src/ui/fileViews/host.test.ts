import { describe, expect, test } from "bun:test";
import {
  createTestDeferred,
  createTestDiffFile,
  createTestSourceFetcher,
} from "../../../../../test/helpers/diff-helpers";
import { createFileViewInput, createFileViewInputSnapshot, fileViewChanges } from "./host";

describe("file-view host input", () => {
  test("exposes only deeply frozen added and removed ranges", () => {
    const changes = fileViewChanges(
      createTestDiffFile({
        before: "before\nstable\nremoved\n",
        after: "after\nstable\nadded\n",
        context: 1,
      }),
    );

    expect(changes.length).toBeGreaterThan(0);
    expect(new Set(changes.map((change) => change.kind))).toEqual(new Set(["added", "removed"]));
    expect(changes.every((change) => !("side" in change))).toBe(true);
    expect(Object.isFrozen(changes)).toBe(true);
    expect(
      changes.every((change) => Object.isFrozen(change) && Object.isFrozen(change.range)),
    ).toBe(true);
  });

  test("reuses one immutable file-and-change snapshot for matching and layout", () => {
    const diffFile = createTestDiffFile();
    const snapshot = createFileViewInputSnapshot(diffFile);
    const input = createFileViewInput(diffFile, 72, new AbortController().signal, snapshot);

    expect(input.file).toBe(snapshot.file);
    expect(input.changes).toBe(snapshot.changes);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test("exposes one frozen input, deduplicates string reads, and binds cancellation", async () => {
    const deferred = createTestDeferred<string | null>();
    const sourceFetcher = createTestSourceFetcher(() => deferred.promise);
    const controller = new AbortController();
    const input = createFileViewInput(createTestDiffFile({ sourceFetcher }), 72, controller.signal);

    const first = input.readDocument("new");
    const second = input.readDocument("new");
    expect(sourceFetcher.calls).toEqual(["new"]);
    expect(input.width).toBe(72);
    expect(input.signal).toBe(controller.signal);
    expect(Object.isFrozen(input)).toBe(true);

    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    deferred.resolve("after");
  });

  test("returns exact document text directly", async () => {
    const input = createFileViewInput(
      createTestDiffFile({
        sourceFetcher: createTestSourceFetcher(async () => "after"),
      }),
      80,
      new AbortController().signal,
    );

    await expect(input.readDocument("new")).resolves.toBe("after");
  });
});
