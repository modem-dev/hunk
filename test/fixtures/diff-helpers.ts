import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../../src/core/types";

export function lines(...values: string[]) {
  return `${values.join("\n")}\n`;
}

export function createDiffFile({
  after = "const alpha = 10;\nconst beta = 2;\nconst gamma = 30;\nconst stable = true;\n",
  before = "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\nconst stable = true;\n",
  id = "example",
  language = "typescript",
  path = "example.ts",
  previousPath,
}: {
  after?: string;
  before?: string;
  id?: string;
  language?: string;
  path?: string;
  previousPath?: string;
} = {}): DiffFile {
  const metadata = parseDiffFromFile(
    { cacheKey: `${id}:before`, contents: before, name: path },
    { cacheKey: `${id}:after`, contents: after, name: path },
    { context: 0 },
    true,
  );

  return {
    agent: null,
    id,
    language,
    metadata,
    patch: "",
    path,
    previousPath,
    stats: { additions: 1, deletions: 1 },
  };
}

export function createHeaderOnlyDiffFile(): DiffFile {
  const file = createDiffFile({
    before: "const alpha = 1;\n",
    after: "const alpha = 2;\n",
    id: "header-only",
    path: "header-only.ts",
  });

  return {
    ...file,
    metadata: {
      ...file.metadata,
      isPartial: true,
      hunks: file.metadata.hunks.map((hunk) => ({
        ...hunk,
        additionLines: 0,
        deletionLines: 0,
        hunkContent: [],
      })),
    },
  };
}
