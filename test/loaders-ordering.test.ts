import { describe, expect, test } from "bun:test";
import type { AgentContext } from "../src/core/types";
import { orderDiffFiles } from "../src/core/loaders";
import { createDiffFile } from "./fixtures/diff-helpers";

function agentContext(...paths: string[]): AgentContext {
  return {
    files: paths.map((path) => ({ annotations: [], path })),
    version: 1,
  };
}

describe("orderDiffFiles", () => {
  test("orders files by agent narrative order", () => {
    const files = [
      createDiffFile({ id: "beta", path: "beta.ts" }),
      createDiffFile({ id: "gamma", path: "gamma.ts" }),
      createDiffFile({ id: "alpha", path: "alpha.ts" }),
    ];

    const ordered = orderDiffFiles(files, agentContext("alpha.ts", "gamma.ts"));

    expect(ordered.map((file) => file.path)).toEqual(["alpha.ts", "gamma.ts", "beta.ts"]);
  });

  test("keeps files not mentioned in context in their original relative order at the end", () => {
    const files = [
      createDiffFile({ id: "beta", path: "beta.ts" }),
      createDiffFile({ id: "delta", path: "delta.ts" }),
      createDiffFile({ id: "alpha", path: "alpha.ts" }),
      createDiffFile({ id: "gamma", path: "gamma.ts" }),
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
      createDiffFile({ id: "alpha", path: "alpha.ts" }),
      createDiffFile({ id: "beta", path: "beta.ts" }),
    ];

    expect(orderDiffFiles(files, null).map((file) => file.path)).toEqual(["alpha.ts", "beta.ts"]);
    expect(orderDiffFiles(files, agentContext()).map((file) => file.path)).toEqual([
      "alpha.ts",
      "beta.ts",
    ]);
  });

  test("matches context entries by previousPath when a file was renamed", () => {
    const files = [
      createDiffFile({ id: "renamed", path: "new-name.ts", previousPath: "old-name.ts" }),
      createDiffFile({ id: "beta", path: "beta.ts" }),
      createDiffFile({ id: "alpha", path: "alpha.ts" }),
    ];

    const ordered = orderDiffFiles(files, agentContext("alpha.ts", "old-name.ts"));

    expect(ordered.map((file) => file.path)).toEqual(["alpha.ts", "new-name.ts", "beta.ts"]);
  });
});
