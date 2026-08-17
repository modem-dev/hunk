import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import { highlightWorkerCacheKey } from "./highlightWorkerIdentity";

/** Build worker inputs from actual Pierre metadata rather than an incomplete test shape. */
function createTestIdentity({ after = "const answer = 42;\n", name = "example.ts" } = {}) {
  return {
    aliasContext: true,
    appearance: "dark" as const,
    language: "typescript",
    metadata: parseDiffFromFile(
      { name, contents: "const answer = 41;\n", cacheKey: "before" },
      { name, contents: after, cacheKey: "after" },
      { context: 3 },
      true,
    ),
    theme: "pierre-dark",
  };
}

describe("highlight worker cache identity", () => {
  test("matches equivalent full worker inputs", () => {
    expect(highlightWorkerCacheKey(createTestIdentity())).toBe(
      highlightWorkerCacheKey(createTestIdentity()),
    );
  });

  test("changes for same-length diff text and rendering inputs", () => {
    const base = createTestIdentity();
    const sameLengthText = createTestIdentity({ after: "const answer = 24;\n" });

    expect(highlightWorkerCacheKey(sameLengthText)).not.toBe(highlightWorkerCacheKey(base));
    expect(highlightWorkerCacheKey({ ...base, aliasContext: false })).not.toBe(
      highlightWorkerCacheKey(base),
    );
    expect(
      highlightWorkerCacheKey({ ...base, appearance: "light", theme: "pierre-light" }),
    ).not.toBe(highlightWorkerCacheKey(base));
    expect(highlightWorkerCacheKey({ ...base, language: "javascript" })).not.toBe(
      highlightWorkerCacheKey(base),
    );
    expect(highlightWorkerCacheKey(createTestIdentity({ name: "example.js" }))).not.toBe(
      highlightWorkerCacheKey(base),
    );
  });
});
