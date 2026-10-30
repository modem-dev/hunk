import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveSnapshotExportPath, snapshotPositionMatches } from "./index";
import type { ExtensionReviewSnapshot } from "../../../packages/hunk/src/extension-api/types";

/** Build the minimal immutable snapshot position these helper tests compare. */
function createTestSnapshot(
  generation = "generation:test:1",
  stateRevision = 2,
): ExtensionReviewSnapshot {
  return Object.freeze({
    generation,
    stateRevision,
    files: Object.freeze([]),
    notes: Object.freeze([]),
  });
}

describe("review snapshot export example", () => {
  test("resolves relative output paths from the command working directory", () => {
    expect(resolveSnapshotExportPath(resolve("repo"), "out/review.json")).toBe(
      resolve("repo", "out/review.json"),
    );
  });

  test("accepts only the exact generation and state revision captured before async work", () => {
    const captured = createTestSnapshot();

    expect(snapshotPositionMatches(captured, createTestSnapshot())).toBe(true);
    expect(snapshotPositionMatches(captured, createTestSnapshot("generation:test:2", 2))).toBe(
      false,
    );
    expect(snapshotPositionMatches(captured, createTestSnapshot("generation:test:1", 3))).toBe(
      false,
    );
    expect(snapshotPositionMatches(captured, null)).toBe(false);
  });
});
