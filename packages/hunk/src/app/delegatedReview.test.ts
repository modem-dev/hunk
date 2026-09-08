import { describe, expect, test } from "bun:test";
import type { ExtensionReviewDescriptor } from "../extension-api/types";
import { reviewDescriptorAfterReload, reviewDescriptorResourceCwd } from "./delegatedReview";

const review: ExtensionReviewDescriptor = {
  kind: "change-request",
  provider: "GitHub",
  title: "PR title",
  id: "#123",
};
const commitReview: ExtensionReviewDescriptor = {
  kind: "commit",
  provider: "Git",
  title: "Commit title",
  revision: "abc1234",
};
const comparisonReview: ExtensionReviewDescriptor = {
  kind: "comparison",
  provider: "Git",
  title: "2 commits",
  base: "parent-a",
  head: "revision-a",
};
const patch = (file?: string) => ({ kind: "patch" as const, file, options: {} });

describe("delegated review reload identity", () => {
  test("uses the repository root for VCS reviews launched from a subdirectory", () => {
    expect(
      reviewDescriptorResourceCwd(
        { kind: "show", ref: "revision-a", options: { vcs: "git" } },
        "/repo/packages/example",
        "/repo",
      ),
    ).toBe("/repo");
    expect(
      reviewDescriptorResourceCwd(patch("review.diff"), "/repo/packages/example", "/repo"),
    ).toBe("/repo/packages/example");
  });

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

  test("preserves history commit metadata only for the same provider review request", () => {
    const show = (ref: string, vcs = "git") => ({
      kind: "show" as const,
      ref,
      options: { vcs },
    });
    const range = (from: string, to: string, vcs = "git") => ({
      kind: "vcs" as const,
      rangeEndpoints: { from, to },
      staged: false,
      options: { vcs },
    });

    expect(
      reviewDescriptorAfterReload(
        show("revision-a"),
        "/repo",
        commitReview,
        show("revision-a"),
        "/repo",
      ),
    ).toBe(commitReview);
    expect(
      reviewDescriptorAfterReload(
        range("parent-a", "revision-a"),
        "/repo",
        commitReview,
        range("parent-a", "revision-a"),
        "/repo",
      ),
    ).toBe(commitReview);
    expect(
      reviewDescriptorAfterReload(
        range("parent-a", "revision-a"),
        "/repo",
        comparisonReview,
        range("parent-a", "revision-a"),
        "/repo",
      ),
    ).toBe(comparisonReview);
    expect(
      reviewDescriptorAfterReload(
        show("revision-a"),
        "/repo",
        commitReview,
        show("revision-b"),
        "/repo",
      ),
    ).toBeUndefined();
    expect(
      reviewDescriptorAfterReload(
        show("revision-a"),
        "/repo",
        commitReview,
        show("revision-a", "jj"),
        "/repo",
      ),
    ).toBeUndefined();
  });

  test("does not preserve change-request metadata onto a VCS review", () => {
    expect(
      reviewDescriptorAfterReload(
        { kind: "show", ref: "revision-a", options: { vcs: "git" } },
        "/repo",
        review,
        { kind: "show", ref: "revision-a", options: { vcs: "git" } },
        "/repo",
      ),
    ).toBeUndefined();
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
