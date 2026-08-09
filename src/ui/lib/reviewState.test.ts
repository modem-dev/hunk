import { describe, expect, test } from "bun:test";
import { createTestAgentFileContext, createTestDiffFile } from "../../../test/helpers/diff-helpers";
import { findNextAnnotatedFile } from "./reviewState";

function createAnnotatedFile(id: string, path: string) {
  return createTestDiffFile({
    id,
    path,
    before: "const value = 1;\nconst stable = true;\n",
    after: "const value = 2;\nconst stable = true;\n",
    agent: createTestAgentFileContext(path, {
      annotations: [{ newRange: [1, 1], summary: `Explain ${path}` }],
    }),
  });
}

describe("review state helpers", () => {
  test("findNextAnnotatedFile wraps through annotated files and handles empty streams", () => {
    const alpha = createAnnotatedFile("alpha", "alpha.ts");
    const beta = createTestDiffFile({ id: "beta", path: "beta.ts", agent: null });
    const gamma = createAnnotatedFile("gamma", "gamma.ts");

    expect(findNextAnnotatedFile([alpha, beta, gamma], "alpha", 1)).toBe(gamma);
    expect(findNextAnnotatedFile([alpha, beta, gamma], "gamma", 1)).toBe(alpha);
    expect(findNextAnnotatedFile([alpha, beta, gamma], undefined, -1)).toBe(gamma);
    expect(findNextAnnotatedFile([beta], "beta", 1)).toBeNull();
  });
});
