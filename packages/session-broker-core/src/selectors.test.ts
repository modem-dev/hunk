import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { normalizeSessionSelector, repoSelectorDistance } from "./selectors";

describe("session selector paths", () => {
  test("normalizes the repo path and its optional boundary", () => {
    expect(normalizeSessionSelector({ repoRoot: "repo/src", repoBoundary: "repo" })).toEqual({
      repoRoot: resolve("repo/src"),
      repoBoundary: resolve("repo"),
      sessionPath: undefined,
    });
  });

  test("rejects session roots outside a supplied repository boundary", () => {
    const boundary = resolve("repo", "nested");
    const selectorPath = resolve(boundary, "src");

    expect(
      repoSelectorDistance(
        { sessionId: "outer", cwd: resolve("repo"), repoRoot: resolve("repo") },
        selectorPath,
        boundary,
      ),
    ).toBeNull();
    expect(
      repoSelectorDistance(
        { sessionId: "inner", cwd: boundary, repoRoot: boundary },
        selectorPath,
        boundary,
      ),
    ).toBe(1);
  });
});
