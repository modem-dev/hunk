import { parseDiffFromFile } from "@pierre/diffs";
import type { AppBootstrap, DiffFile } from "../src/core/types";

export const DEFAULT_FILE_COUNT = 180;
export const DEFAULT_LINES_PER_FILE = 120;
interface LargeSplitStreamFixtureOptions {
  fileCount?: number;
  linesPerFile?: number;
  changedStartLine?: number;
  changedEndLine?: number;
}

export function createLargeSplitDiffFile(
  index: number,
  {
    linesPerFile = DEFAULT_LINES_PER_FILE,
    changedStartLine = 37,
    changedEndLine = 84,
  }: Omit<LargeSplitStreamFixtureOptions, "fileCount"> = {},
): DiffFile {
  const path = `src/stream${index}.ts`;
  const before = Array.from({ length: linesPerFile }, (_, lineIndex) => {
    const line = lineIndex + 1;
    return `export function stream${index}_${line}(value: number) { return value + ${line}; }\n`;
  }).join("");

  const after = Array.from({ length: linesPerFile }, (_, lineIndex) => {
    const line = lineIndex + 1;
    if (line >= changedStartLine && line <= changedEndLine) {
      return `export function stream${index}_${line}(value: number) { return value * ${line} + ${index}; }\n`;
    }

    return `export function stream${index}_${line}(value: number) { return value + ${line}; }\n`;
  }).join("");

  const metadata = parseDiffFromFile(
    {
      name: path,
      contents: before,
      cacheKey: `stream:${index}:before:${linesPerFile}`,
    },
    {
      name: path,
      contents: after,
      cacheKey: `stream:${index}:after:${linesPerFile}`,
    },
    { context: 3 },
    true,
  );

  return {
    id: `stream:${index}`,
    path,
    patch: "",
    language: "typescript",
    stats: {
      additions: Math.max(0, changedEndLine - changedStartLine + 1),
      deletions: Math.max(0, changedEndLine - changedStartLine + 1),
    },
    metadata,
    agent: null,
  };
}

export function createLargeSplitStreamFiles({
  fileCount = DEFAULT_FILE_COUNT,
  linesPerFile = DEFAULT_LINES_PER_FILE,
  changedStartLine,
  changedEndLine,
}: LargeSplitStreamFixtureOptions = {}) {
  return Array.from({ length: fileCount }, (_, index) =>
    createLargeSplitDiffFile(index + 1, {
      linesPerFile,
      changedStartLine,
      changedEndLine,
    }),
  );
}

export function createLargeSplitStreamBootstrap({
  fileCount = DEFAULT_FILE_COUNT,
  linesPerFile = DEFAULT_LINES_PER_FILE,
  changedStartLine,
  changedEndLine,
}: LargeSplitStreamFixtureOptions = {}): AppBootstrap {
  return {
    input: {
      kind: "vcs",
      staged: false,
      options: {
        mode: "auto",
      },
    },
    changeset: {
      id: `changeset:large-split-stream:${fileCount}:${linesPerFile}`,
      sourceLabel: "repo",
      title: "repo working tree",
      files: createLargeSplitStreamFiles({
        fileCount,
        linesPerFile,
        changedStartLine,
        changedEndLine,
      }),
    },
    initialMode: "split",
    initialTheme: "midnight",
    initialShowAgentNotes: false,
  };
}
