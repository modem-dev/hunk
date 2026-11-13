import { describe, expect, test } from "bun:test";
import type { ReviewDocumentV1 } from "../../core/review/types";
import { createTestReviewDocument } from "../../../../../test/helpers/review-store-helpers";
import type { ValidatedLineHighlight } from "./validate";
import { carryOverLineHighlights } from "./reconcile";

const mark: ValidatedLineHighlight = { side: "new", line: 1, start: 0, end: 4, tone: "current" };

/** Build one document whose runtime ids differ from its keys, as a reload's would. */
function createReloadedDocument(
  files: Array<{ key: string; contentIdentity?: string }>,
  generation: string,
): ReviewDocumentV1 {
  const document = createTestReviewDocument(files);
  return {
    files: document.files.map((file) => ({ ...file, runtimeId: `${file.key}:${generation}` })),
  };
}

describe("carryOverLineHighlights", () => {
  test("re-keys marks onto the replacement runtime id when content is unchanged", () => {
    const previous = createReloadedDocument([{ key: "alpha" }, { key: "beta" }], "1");
    const next = createReloadedDocument([{ key: "alpha" }, { key: "beta" }], "2");

    const carried = carryOverLineHighlights(new Map([["alpha:1", [mark]]]), previous, next);

    expect([...carried.keys()]).toEqual(["alpha:2"]);
    expect(carried.get("alpha:2")).toEqual([mark]);
  });

  test("drops marks for a file that came back with different content", () => {
    const previous = createReloadedDocument([{ key: "alpha" }], "1");
    const next = createReloadedDocument(
      [{ key: "alpha", contentIdentity: "content:changed" }],
      "2",
    );

    const carried = carryOverLineHighlights(new Map([["alpha:1", [mark]]]), previous, next);

    expect(carried.size).toBe(0);
  });

  test("drops marks for a file that left the review", () => {
    const previous = createReloadedDocument([{ key: "alpha" }, { key: "beta" }], "1");
    const next = createReloadedDocument([{ key: "beta" }], "2");

    const carried = carryOverLineHighlights(
      new Map([
        ["alpha:1", [mark]],
        ["beta:1", [mark]],
      ]),
      previous,
      next,
    );

    expect([...carried.keys()]).toEqual(["beta:2"]);
  });

  test("returns an empty map when there is nothing to carry", () => {
    const previous = createReloadedDocument([{ key: "alpha" }], "1");
    const next = createReloadedDocument([{ key: "alpha" }], "2");

    expect(carryOverLineHighlights(new Map(), previous, next).size).toBe(0);
  });
});
