import { describe, expect, test } from "bun:test";
import type { ExtensionReviewDescriptor } from "../extension-api/types";
import { reviewDescriptorAfterReload } from "./delegatedReview";

const review: ExtensionReviewDescriptor = {
  kind: "change-request",
  provider: "GitHub",
  title: "PR title",
  id: "#123",
};
const patch = (file?: string) => ({ kind: "patch" as const, file, options: {} });

describe("delegated review reload identity", () => {
  test("preserves metadata while refreshing the same patch path", () => {
    expect(
      reviewDescriptorAfterReload(
        patch("review.diff"),
        "/tmp",
        review,
        patch("/tmp/review.diff"),
        "/",
      ),
    ).toBe(review);
  });

  test("clears metadata for unrelated explicit and non-file reloads", () => {
    expect(
      reviewDescriptorAfterReload(
        patch("/tmp/pr.diff"),
        "/",
        review,
        patch("/tmp/other.diff"),
        "/",
      ),
    ).toBeUndefined();
    expect(
      reviewDescriptorAfterReload(
        patch("/tmp/pr.diff"),
        "/",
        review,
        { kind: "vcs", staged: false, options: {} },
        "/",
      ),
    ).toBeUndefined();
    expect(reviewDescriptorAfterReload(patch("-"), "/", review, patch("-"), "/")).toBeUndefined();
  });

  test("does not invent metadata for ordinary patches", () => {
    expect(
      reviewDescriptorAfterReload(
        patch("/tmp/pr.diff"),
        "/",
        undefined,
        patch("/tmp/pr.diff"),
        "/",
      ),
    ).toBeUndefined();
  });
});
