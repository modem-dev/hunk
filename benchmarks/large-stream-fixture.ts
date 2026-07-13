import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import type { AppBootstrap, DiffFile } from "../src/core/types";

export const DEFAULT_FILE_COUNT = 180;
export const DEFAULT_LINES_PER_FILE = 120;

// Huge tier: ~1k files / 300k+ total diff lines, used to expose costs that only
// appear at "feels slow" scale (O(files) per-commit work, geometry at startup).
export const HUGE_FILE_COUNT = 1_000;
export const HUGE_LINES_PER_FILE = 300;
export const GIANT_SINGLE_FILE_LINES = 50_000;

/** Content shape for synthetic source lines. */
type ContentVariant = "ascii" | "non-ascii";

interface LargeSplitStreamFixtureOptions {
  fileCount?: number;
  linesPerFile?: number;
  changedStartLine?: number;
  changedEndLine?: number;
  /** "non-ascii" embeds CJK/emoji/box-drawing chars in line content to exercise string-width. */
  contentVariant?: ContentVariant;
}

// Deterministic non-ASCII decorations cycled across lines: CJK, emoji, and
// box-drawing characters all bypass measureTextWidth's ASCII fast path.
const NON_ASCII_DECORATIONS = [
  "日本語のコメント",
  "中文注释内容",
  "한국어 주석",
  "🚀✨🔧💡",
  "┌──┬──┐│▌▾│└──┴──┘",
  "héllo wörld — naïve café",
] as const;

/** Build one deterministic synthetic source line, optionally with non-ASCII content. */
function syntheticLine(
  index: number,
  line: number,
  changed: boolean,
  contentVariant: ContentVariant,
) {
  const body = changed
    ? `export function stream${index}_${line}(value: number) { return value * ${line} + ${index}; }`
    : `export function stream${index}_${line}(value: number) { return value + ${line}; }`;

  if (contentVariant === "non-ascii") {
    const decoration = NON_ASCII_DECORATIONS[(index + line) % NON_ASCII_DECORATIONS.length]!;
    return `${body} // ${decoration}\n`;
  }

  return `${body}\n`;
}

export function createLargeSplitDiffFile(
  index: number,
  {
    linesPerFile = DEFAULT_LINES_PER_FILE,
    changedStartLine = 37,
    changedEndLine = 84,
    contentVariant = "ascii",
  }: Omit<LargeSplitStreamFixtureOptions, "fileCount"> = {},
): DiffFile {
  const path = `src/stream${index}.ts`;
  const before = Array.from({ length: linesPerFile }, (_, lineIndex) =>
    syntheticLine(index, lineIndex + 1, false, contentVariant),
  ).join("");

  const after = Array.from({ length: linesPerFile }, (_, lineIndex) => {
    const line = lineIndex + 1;
    return syntheticLine(
      index,
      line,
      line >= changedStartLine && line <= changedEndLine,
      contentVariant,
    );
  }).join("");

  const metadata = parseDiffFromFile(
    {
      name: path,
      contents: before,
      cacheKey: `stream:${index}:before:${linesPerFile}:${contentVariant}`,
    },
    {
      name: path,
      contents: after,
      cacheKey: `stream:${index}:after:${linesPerFile}:${contentVariant}`,
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
  contentVariant,
}: LargeSplitStreamFixtureOptions = {}) {
  return Array.from({ length: fileCount }, (_, index) =>
    createLargeSplitDiffFile(index + 1, {
      linesPerFile,
      changedStartLine,
      changedEndLine,
      contentVariant,
    }),
  );
}

export function createLargeSplitStreamBootstrap({
  fileCount = DEFAULT_FILE_COUNT,
  linesPerFile = DEFAULT_LINES_PER_FILE,
  changedStartLine,
  changedEndLine,
  contentVariant = "ascii",
}: LargeSplitStreamFixtureOptions = {}): AppBootstrap {
  return {
    reloadContext: { cwd: process.cwd() },
    input: {
      kind: "vcs",
      staged: false,
      options: {
        mode: "auto",
      },
    },
    changeset: {
      id: `changeset:large-split-stream:${fileCount}:${linesPerFile}:${contentVariant}`,
      sourceLabel: "repo",
      title: "repo working tree",
      files: createLargeSplitStreamFiles({
        fileCount,
        linesPerFile,
        changedStartLine,
        changedEndLine,
        contentVariant,
      }),
    },
    initialMode: "split",
    initialTheme: "midnight",
    initialShowAgentNotes: false,
  };
}

/**
 * Build one giant single-file DiffFile by synthesizing unified patch text directly.
 *
 * parseDiffFromFile runs a Myers diff, which is O(N·D) — ~8 minutes for a 50k-line
 * file with a 44k-line changed region. The change shape is fully known here, so we
 * emit the patch text ourselves and let Pierre parse it (~hundreds of ms instead).
 */
export function createGiantSingleDiffFile(
  index: number,
  {
    linesPerFile = GIANT_SINGLE_FILE_LINES,
    changedStartLine = 1_000,
    changedEndLine = 45_000,
  }: Omit<LargeSplitStreamFixtureOptions, "fileCount" | "contentVariant"> = {},
): DiffFile {
  const path = `src/stream${index}.ts`;
  const context = 3;
  const hunkStart = Math.max(1, changedStartLine - context);
  const hunkEnd = Math.min(linesPerFile, changedEndLine + context);
  const lineCount = hunkEnd - hunkStart + 1;
  const changedLines = changedEndLine - changedStartLine + 1;

  const patchLines: string[] = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${hunkStart},${lineCount} +${hunkStart},${lineCount} @@`,
  ];

  // One hunk: leading context, all deletions, all additions, trailing context.
  const contentLine = (line: number, changed: boolean) =>
    syntheticLine(index, line, changed, "ascii").slice(0, -1);
  for (let line = hunkStart; line < changedStartLine; line += 1) {
    patchLines.push(` ${contentLine(line, false)}`);
  }
  for (let line = changedStartLine; line <= changedEndLine; line += 1) {
    patchLines.push(`-${contentLine(line, false)}`);
  }
  for (let line = changedStartLine; line <= changedEndLine; line += 1) {
    patchLines.push(`+${contentLine(line, true)}`);
  }
  for (let line = changedEndLine + 1; line <= hunkEnd; line += 1) {
    patchLines.push(` ${contentLine(line, false)}`);
  }

  const patchText = `${patchLines.join("\n")}\n`;
  const metadata = parsePatchFiles(patchText, `stream:${index}`, true).flatMap(
    (entry) => entry.files,
  )[0]!;

  return {
    id: `stream:${index}`,
    path,
    patch: "",
    language: "typescript",
    stats: {
      additions: changedLines,
      deletions: changedLines,
    },
    metadata,
    agent: null,
  };
}

/** Bootstrap for the huge tier: ~1k files plus one giant ~50k-line file at the end. */
export function createHugeStreamBootstrap(): AppBootstrap {
  const files = createLargeSplitStreamFiles({
    fileCount: HUGE_FILE_COUNT,
    linesPerFile: HUGE_LINES_PER_FILE,
  });

  // One giant single file with a very large changed region, modeled after lock
  // files and generated artifacts that dominate real "slow diff" reports.
  files.push(createGiantSingleDiffFile(HUGE_FILE_COUNT + 1));

  return {
    reloadContext: { cwd: process.cwd() },
    input: {
      kind: "vcs",
      staged: false,
      options: {
        mode: "auto",
      },
    },
    changeset: {
      id: `changeset:huge-stream:${HUGE_FILE_COUNT}:${HUGE_LINES_PER_FILE}:${GIANT_SINGLE_FILE_LINES}`,
      sourceLabel: "repo",
      title: "repo working tree",
      files,
    },
    initialMode: "split",
    initialTheme: "midnight",
    initialShowAgentNotes: false,
  };
}
