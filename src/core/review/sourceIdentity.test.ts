import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { reviewInputSourceIdentity } from "./sourceIdentity";
import { projectReviewDocument } from "./document";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";

const options = { mode: "auto" as const };

describe("review input source identity", () => {
  test("distinguishes direct comparisons with the same basenames in different directories", () => {
    const cwd = join("tmp", "reviews");
    const firstInput = {
      kind: "diff" as const,
      left: join("repo-a", "before", "index.ts"),
      right: join("repo-a", "after", "index.ts"),
      options,
    };
    const secondInput = {
      kind: "diff" as const,
      left: join("repo-b", "before", "index.ts"),
      right: join("repo-b", "after", "index.ts"),
      options,
    };
    const context = { cwd };
    const firstIdentity = reviewInputSourceIdentity(firstInput, context);
    const secondIdentity = reviewInputSourceIdentity(secondInput, context);
    expect(firstIdentity).not.toBe(secondIdentity);

    const reviewedFile = createTestDiffFile({
      id: "index",
      path: "index.ts",
      before: "const value = 1;\n",
      after: "const value = 2;\n",
    });
    const project = (sourceIdentity: string) =>
      projectReviewDocument(
        {
          id: "same-label-and-id",
          sourceLabel: "index.ts ↔ index.ts",
          title: "index.ts",
          files: [reviewedFile],
        },
        { sourceIdentity },
      ).document;
    const first = project(firstIdentity);
    const second = project(secondIdentity);
    expect(first.documentIdentity).not.toBe(second.documentIdentity);
    expect(first.files[0]!.key).not.toBe(second.files[0]!.key);
    expect(JSON.stringify(first)).not.toContain(join(cwd, "repo-a"));
  });

  test("scopes inline and dash-file patches by a digest without exposing text", () => {
    const context = { cwd: "/work/review" };
    const patch = (text: string, file?: string) =>
      reviewInputSourceIdentity({ kind: "patch", file, text, options }, context);
    const first = patch("diff --git a/a.ts b/a.ts\n-old\n+first\n");
    const second = patch("diff --git a/a.ts b/a.ts\n-old\n+second\n");
    const dash = patch("diff --git a/a.ts b/a.ts\n-old\n+first\n", "-");

    expect(first).not.toBe(second);
    expect(dash).toBe(first);
    expect(first).not.toContain("diff --git");
    expect(first).not.toContain("+first");
  });

  test("keeps one repository input stable while separating repositories", () => {
    const input = { kind: "vcs" as const, staged: false, options };
    expect(reviewInputSourceIdentity(input, { cwd: "/work/a", repoRoot: "/repo/a" })).toBe(
      reviewInputSourceIdentity(input, { cwd: "/work/a/subdir", repoRoot: "/repo/a" }),
    );
    expect(reviewInputSourceIdentity(input, { cwd: "/work/a", repoRoot: "/repo/a" })).not.toBe(
      reviewInputSourceIdentity(input, { cwd: "/work/b", repoRoot: "/repo/b" }),
    );
  });
});
