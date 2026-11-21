import { describe, expect, test } from "bun:test";
import { reviewBarHints } from "./reviewBarHints";

describe("reviewBarHints", () => {
  test("reads every key from the chord lookup, by command id", () => {
    const hints = reviewBarHints((id) => `<${id}>`);
    expect(hints.map((hint) => hint.label)).toEqual([
      "hunk",
      "file",
      "annotated",
      "add note",
      "viewed",
    ]);
    expect(hints[0]!.keys).toEqual(["<hunk.review.previousHunk>", "<hunk.review.nextHunk>"]);
    expect(hints[4]!.keys).toEqual(["<hunk.web.toggleViewed>"]);
  });

  test("leaves out unbound commands and keeps the bound half of a pair", () => {
    const bound: Record<string, string> = {
      "hunk.review.nextHunk": "n",
      "hunk.review.startNote": "x",
    };
    expect(reviewBarHints((id) => bound[id])).toEqual([
      { id: "hunk", keys: ["n"], label: "hunk" },
      { id: "note", keys: ["x"], label: "add note" },
    ]);
  });

  test("shows nothing when nothing is bound", () => {
    expect(reviewBarHints(() => undefined)).toEqual([]);
  });
});
