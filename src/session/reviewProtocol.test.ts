import { describe, expect, test } from "bun:test";
import {
  parseApplyReviewActionInput,
  parseGetReviewSnapshotInput,
  parseReadReviewResourceInput,
} from "./reviewProtocol";

describe("review protocol generation validation", () => {
  test("rejects 300 KiB and invalid generations in every producer command", () => {
    const invalidGenerations = ["g".repeat(300 * 1024), "generation with spaces", "generation:💥"];

    for (const generation of invalidGenerations) {
      expect(
        parseReadReviewResourceInput({
          sessionId: "session-1",
          generation,
          resourceId: "resource:1",
          offset: 0,
          length: 1,
        }),
      ).toBeNull();
      expect(
        parseApplyReviewActionInput({
          sessionId: "session-1",
          generation,
          action: { type: "notes/set-visibility", visible: true },
        }),
      ).toBeNull();
      expect(parseGetReviewSnapshotInput({ sessionId: "session-1", generation })).toBeNull();
    }
  });

  test("accepts runtime-compatible compact generation identifiers", () => {
    const generation = `generation:${"a".repeat(64)}`;
    expect(parseGetReviewSnapshotInput({ sessionId: "session-1", generation })).toMatchObject({
      generation,
    });
  });
});
