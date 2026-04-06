import { describe, expect, test } from "bun:test";
import type { AgentContext } from "./types";
import { orderDiffFiles } from "./loaders";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";

function agentContext(...paths: string[]): AgentContext {
  return {
    files: paths.map((path) => ({ annotations: [], path })),
    version: 1,
  };
}

describe("orderDiffFiles", () => {
  test("orders files by agent narrative order", () => {
    const files = [
      createTestDiffFile({ id: "beta", path: "beta.ts" }),
      createTestDiffFile({ id: "gamma", path: "gamma.ts" }),
      createTestDiffFile({ id: "alpha", path: "alpha.ts" }),
    ];

    const ordered = orderDiffFiles(files, agentContext("alpha.ts", "gamma.ts"));

    expect(ordered.map((file) => file.path)).toEqual(["alpha.ts", "gamma.ts", "beta.ts"]);
  });

  test("keeps files not mentioned in context in their original relative order at the end", () => {
    const files = [
      createTestDiffFile({ id: "beta", path: "beta.ts" }),
      createTestDiffFile({ id: "delta", path: "delta.ts" }),
      createTestDiffFile({ id: "alpha", path: "alpha.ts" }),
      createTestDiffFile({ id: "gamma", path: "gamma.ts" }),
    ];

    const ordered = orderDiffFiles(files, agentContext("gamma.ts"));

    expect(ordered.map((file) => file.path)).toEqual([
      "gamma.ts",
      "beta.ts",
      "delta.ts",
      "alpha.ts",
    ]);
  });

  test("returns files unchanged when the agent context is empty or missing", () => {
    const files = [
      createTestDiffFile({ id: "alpha", path: "alpha.ts" }),
      createTestDiffFile({ id: "beta", path: "beta.ts" }),
    ];

    expect(orderDiffFiles(files, null).map((file) => file.path)).toEqual(["alpha.ts", "beta.ts"]);
    expect(orderDiffFiles(files, agentContext()).map((file) => file.path)).toEqual([
      "alpha.ts",
      "beta.ts",
    ]);
  });

  test("matches context entries by previousPath when a file was renamed", () => {
    const files = [
      createTestDiffFile({ id: "renamed", path: "new-name.ts", previousPath: "old-name.ts" }),
      createTestDiffFile({ id: "beta", path: "beta.ts" }),
      createTestDiffFile({ id: "alpha", path: "alpha.ts" }),
    ];

    const ordered = orderDiffFiles(files, agentContext("alpha.ts", "old-name.ts"));

    expect(ordered.map((file) => file.path)).toEqual(["alpha.ts", "new-name.ts", "beta.ts"]);
  });
});
