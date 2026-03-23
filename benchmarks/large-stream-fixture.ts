import { parseDiffFromFile } from "@pierre/diffs";
import type { AppBootstrap, DiffFile } from "../src/core/types";

export const DEFAULT_FILE_COUNT = 180;
export const DEFAULT_LINES_PER_FILE = 120;
export const DEFAULT_NOTES_PER_FILE = 2;

interface LargeSplitStreamFixtureOptions {
  fileCount?: number;
  linesPerFile?: number;
  notesPerFile?: number;
}

function createAgentAnnotations(index: number, notesPerFile: number) {
  if (notesPerFile <= 0) {
    return [];
  }

  return Array.from({ length: notesPerFile }, (_, noteIndex) => {
    const startLine = 40 + noteIndex * 12;
    const endLine = startLine + 5;
    return {
      id: `note:${index}:${noteIndex}`,
      newRange: [startLine, endLine] as [number, number],
      summary: `Explain the split-mode refactor in file ${index}, hunk note ${noteIndex + 1}.`,
      rationale:
        "Synthetic benchmark note to exercise inline note placement, guide rows, and note-enabled full-stream rendering.",
    };
  });
}

export function createLargeSplitDiffFile(
  index: number,
  {
    linesPerFile = DEFAULT_LINES_PER_FILE,
    notesPerFile = 0,
  }: Omit<LargeSplitStreamFixtureOptions, "fileCount"> = {},
): DiffFile {
  const path = `src/stream${index}.ts`;
  const before = Array.from({ length: linesPerFile }, (_, lineIndex) => {
    const line = lineIndex + 1;
    return `export function stream${index}_${line}(value: number) { return value + ${line}; }\n`;
  }).join("");

  const after = Array.from({ length: linesPerFile }, (_, lineIndex) => {
    const line = lineIndex + 1;
    if (lineIndex >= 36 && lineIndex < 84) {
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

  const annotations = createAgentAnnotations(index, notesPerFile);

  return {
    id: `stream:${index}`,
    path,
    patch: "",
    language: "typescript",
    stats: { additions: 48, deletions: 48 },
    metadata,
    agent:
      annotations.length > 0
        ? {
            path,
            summary: `Synthetic note-heavy benchmark context for ${path}`,
            annotations,
          }
        : null,
  };
}

export function createLargeSplitStreamFiles({
  fileCount = DEFAULT_FILE_COUNT,
  linesPerFile = DEFAULT_LINES_PER_FILE,
  notesPerFile = 0,
}: LargeSplitStreamFixtureOptions = {}) {
  return Array.from({ length: fileCount }, (_, index) =>
    createLargeSplitDiffFile(index + 1, { linesPerFile, notesPerFile }),
  );
}

export function createLargeSplitStreamBootstrap({
  fileCount = DEFAULT_FILE_COUNT,
  linesPerFile = DEFAULT_LINES_PER_FILE,
  notesPerFile = 0,
}: LargeSplitStreamFixtureOptions = {}): AppBootstrap {
  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: "auto",
      },
    },
    changeset: {
      id: `changeset:large-split-stream:${fileCount}:${linesPerFile}:${notesPerFile}`,
      sourceLabel: "repo",
      title: "repo working tree",
      files: createLargeSplitStreamFiles({ fileCount, linesPerFile, notesPerFile }),
    },
    initialMode: "split",
    initialTheme: "midnight",
    initialShowAgentNotes: notesPerFile > 0,
  };
}
