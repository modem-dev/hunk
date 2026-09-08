import { describe, expect, test } from "bun:test";
import { buildReviewAnnotationIndex } from "../../core/review/annotations";
import {
  createTestAgentFileContext,
  createTestDiffFile,
} from "../../../../../test/helpers/diff-helpers";
import {
  buildReviewStreamState,
  buildSelectedHunkSummary,
  resolveReviewNavigationTarget,
} from "./reviewState";

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
  // Intent: stale selections keep their requested index without inventing ranges.
  test("buildSelectedHunkSummary preserves stale out-of-range selections", () => {
    const file = createTestDiffFile();

    expect(buildSelectedHunkSummary(file, 99)).toEqual({ index: 99 });
  });

  // Intent: the visible stream answers the same query the shared filter matcher does.
  test("buildReviewStreamState filters on path, previous path, and agent summary", () => {
    const alpha = createTestDiffFile({ id: "alpha", path: "src/alpha.ts" });
    const beta = createTestDiffFile({
      id: "beta",
      path: "src/beta.ts",
      previousPath: "src/legacy-name.ts",
    });
    const gamma = createAnnotatedFile("gamma", "src/gamma.ts");
    const files = [alpha, beta, gamma];

    const visibleFor = (filterQuery: string) =>
      buildReviewStreamState({ files, liveCommentsByFileId: {}, filterQuery }).visibleFiles.map(
        (file) => file.id,
      );

    expect(visibleFor("")).toEqual(["alpha", "beta", "gamma"]);
    expect(visibleFor("ALPHA")).toEqual(["alpha"]);
    expect(visibleFor("legacy-name")).toEqual(["beta"]);
    // The agent's file summary is part of the haystack, not just the path.
    expect(visibleFor("gamma.ts note")).toEqual(["gamma"]);
    expect(visibleFor("nothing-matches")).toEqual([]);
  });

  // Intent: annotated navigation plans against a file-key index the terminal derives once.
  test("buildReviewAnnotationIndex separates annotated files from annotated hunks", () => {
    const annotated = createAnnotatedFile("alpha", "alpha.ts");
    const summaryOnly = createTestDiffFile({
      id: "beta",
      path: "beta.ts",
      agent: createTestAgentFileContext("beta.ts", { annotations: [] }),
    });
    const plain = createTestDiffFile({ id: "gamma", path: "gamma.ts", agent: null });
    const keyByFileId = new Map([
      ["alpha", "key:alpha"],
      ["beta", "key:beta"],
      ["gamma", "key:gamma"],
    ]);

    const index = buildReviewAnnotationIndex([annotated, summaryOnly, plain], keyByFileId);

    // A file carrying review context but no note inside a hunk is still an annotated file.
    expect([...index.annotatedFileKeys]).toEqual(["key:alpha", "key:beta"]);
    expect([...index.annotatedHunkIndicesByFileKey.keys()]).toEqual(["key:alpha"]);
    expect([...(index.annotatedHunkIndicesByFileKey.get("key:alpha") ?? [])]).toEqual([0]);
  });

  // Intent: absolute navigation supports both hunk index and side+line addressing.
  test("resolveReviewNavigationTarget resolves paths by explicit hunk or side and line", () => {
    const file = createTestDiffFile({ id: "alpha", path: "src/alpha.ts" });

    expect(
      resolveReviewNavigationTarget({
        allFiles: [file],
        input: { filePath: "src/alpha.ts", hunkIndex: 0 },
      }),
    ).toEqual({ file, hunkIndex: 0 });

    expect(
      resolveReviewNavigationTarget({
        allFiles: [file],
        input: { filePath: "src/alpha.ts", side: "new", line: 1 },
      }),
    ).toEqual({ file, hunkIndex: 0 });
  });

  // Intent: invalid agent navigation requests fail before mutating review state.
  test("resolveReviewNavigationTarget rejects missing and invalid targets", () => {
    const file = createTestDiffFile({ id: "alpha", path: "src/alpha.ts" });
    const baseInput = { allFiles: [file] };

    expect(() => resolveReviewNavigationTarget({ ...baseInput, input: {} })).toThrow(
      "navigate requires --file",
    );
    expect(() =>
      resolveReviewNavigationTarget({
        ...baseInput,
        input: { filePath: "missing.ts", hunkIndex: 0 },
      }),
    ).toThrow("No diff file matches missing.ts");
    expect(() =>
      resolveReviewNavigationTarget({ ...baseInput, input: { filePath: "src/alpha.ts" } }),
    ).toThrow("hunkIndex or both side and line");
    expect(() =>
      resolveReviewNavigationTarget({
        ...baseInput,
        input: { filePath: "src/alpha.ts", hunkIndex: 20 },
      }),
    ).toThrow("No diff hunk");
  });
});
