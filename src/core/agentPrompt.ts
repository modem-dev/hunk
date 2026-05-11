import type { DiffFile } from "./types";
import { formatHunkHeader } from "./hunkHeader";
import { hunkLineRange } from "./liveComments";

export interface AgentPromptHunk {
  index: number;
  header: string;
  oldRange?: [number, number];
  newRange?: [number, number];
}

export interface AgentPromptFile {
  path: string;
  previousPath?: string;
  patch?: string;
  hunks: AgentPromptHunk[];
}

export interface AgentPromptInput {
  title?: string;
  sourceLabel?: string;
  repoRoot?: string;
  file: AgentPromptFile;
  hunkIndex: number;
  selectedText?: string;
  comment?: string;
}

function trimTrailingNewlines(value: string) {
  return value.replace(/\n+$/, "");
}

function codeFence(language: string, value: string) {
  const longestFence = Math.max(
    2,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestFence + 1);
  return `${fence}${language}\n${trimTrailingNewlines(value)}\n${fence}`;
}

function formatRange(range: [number, number] | undefined) {
  if (!range) {
    return "-";
  }

  return range[0] === range[1] ? `${range[0]}` : `${range[0]}..${range[1]}`;
}

/** Convert one loaded diff file into the generic prompt-export shape. */
export function createAgentPromptFile(file: DiffFile): AgentPromptFile {
  return {
    path: file.path,
    previousPath: file.previousPath,
    patch: file.patch,
    hunks: file.metadata.hunks.map((hunk, index) => ({
      index,
      header: formatHunkHeader(hunk),
      ...hunkLineRange(hunk),
    })),
  };
}

/** Extract one raw unified-diff hunk from a per-file patch, preserving file headers. */
export function extractHunkPatch(patch: string | undefined, hunkIndex: number) {
  if (!patch) {
    return undefined;
  }

  const normalizedPatch = patch.replaceAll("\r\n", "\n");
  const lines = normalizedPatch.split("\n");
  const hunkLineIndexes = lines.reduce<number[]>((indexes, line, index) => {
    if (line.startsWith("@@ ")) {
      indexes.push(index);
    }

    return indexes;
  }, []);
  const hunkStart = hunkLineIndexes[hunkIndex];
  if (hunkStart === undefined) {
    return undefined;
  }

  const firstHunkStart = hunkLineIndexes[0] ?? hunkStart;
  const hunkEnd = hunkLineIndexes[hunkIndex + 1] ?? lines.length;
  const headerLines = lines.slice(0, firstHunkStart).filter((line) => line.length > 0);
  const hunkLines = lines.slice(hunkStart, hunkEnd);
  const selectedLines = [...headerLines, ...hunkLines];

  return trimTrailingNewlines(selectedLines.join("\n"));
}

/** Build a paste-ready prompt for sending the focused Hunk context to a coding agent. */
export function buildAgentPrompt({
  title,
  sourceLabel,
  repoRoot,
  file,
  hunkIndex,
  selectedText,
  comment,
}: AgentPromptInput) {
  const hunk = file.hunks[hunkIndex];
  if (!hunk) {
    throw new Error(`No hunk ${hunkIndex + 1} exists in ${file.path}.`);
  }

  const normalizedComment = comment?.trim();
  const normalizedSelection = selectedText?.trim();
  const diffSnippet = extractHunkPatch(file.patch, hunkIndex) ?? hunk.header;
  const locationLines = [
    `- Repo: ${repoRoot ?? sourceLabel ?? "(unknown)"}`,
    ...(title ? [`- Review: ${title}`] : []),
    `- File: ${file.path}`,
    ...(file.previousPath ? [`- Previous file: ${file.previousPath}`] : []),
    `- Hunk: ${hunk.index + 1}`,
    `- Old lines: ${formatRange(hunk.oldRange)}`,
    `- New lines: ${formatRange(hunk.newRange)}`,
  ];

  return trimTrailingNewlines(
    [
      "Please use this Hunk review context to help me update the code.",
      "",
      "Context:",
      ...locationLines,
      ...(normalizedComment ? ["", "My comment:", normalizedComment] : []),
      ...(normalizedSelection
        ? ["", "Selected text from Hunk:", codeFence("text", normalizedSelection)]
        : []),
      "",
      "Diff hunk:",
      codeFence("diff", diffSnippet),
      "",
      "Please address my comment against this diff. If you need more surrounding code, ask before editing.",
    ].join("\n"),
  );
}
