import type { DiffFile } from "../../core/types";
import type { DiffRow, RenderSpan } from "../diff/pierre";

export type SearchSide = "single" | "left" | "right";

export type DiffSide = "old" | "new";

export interface FileSearchMatch {
  fileId: string;
  filePath: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
  columnStart: number;
  columnEnd: number;
}

export interface SearchMatch {
  rowIndex: number;
  fileId: string;
  hunkIndex: number;
  side: SearchSide;
  columnStart: number;
  columnEnd: number;
}

export interface FindSearchMatchesOptions {
  caseSensitive?: boolean;
}

function joinSpans(spans: RenderSpan[]) {
  let text = "";
  for (const span of spans) {
    text += span.text;
  }
  return text;
}

function pushMatchesInText(
  out: SearchMatch[],
  haystack: string,
  needle: string,
  rowIndex: number,
  fileId: string,
  hunkIndex: number,
  side: SearchSide,
) {
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) {
      return;
    }

    out.push({
      rowIndex,
      fileId,
      hunkIndex,
      side,
      columnStart: index,
      columnEnd: index + needle.length,
    });
    cursor = index + needle.length;
  }
}

/** Scan rendered diff rows for all occurrences of one query string. */
export function findSearchMatches(
  rows: DiffRow[],
  rawQuery: string,
  options: FindSearchMatchesOptions = {},
): SearchMatch[] {
  if (!rawQuery) {
    return [];
  }

  const caseSensitive = options.caseSensitive ?? false;
  const needle = caseSensitive ? rawQuery : rawQuery.toLowerCase();
  const out: SearchMatch[] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;

    if (row.type === "split-line") {
      const leftText = joinSpans(row.left.spans);
      const rightText = joinSpans(row.right.spans);
      pushMatchesInText(
        out,
        caseSensitive ? leftText : leftText.toLowerCase(),
        needle,
        rowIndex,
        row.fileId,
        row.hunkIndex,
        "left",
      );
      pushMatchesInText(
        out,
        caseSensitive ? rightText : rightText.toLowerCase(),
        needle,
        rowIndex,
        row.fileId,
        row.hunkIndex,
        "right",
      );
      continue;
    }

    if (row.type === "stack-line") {
      const text = joinSpans(row.cell.spans);
      pushMatchesInText(
        out,
        caseSensitive ? text : text.toLowerCase(),
        needle,
        rowIndex,
        row.fileId,
        row.hunkIndex,
        "single",
      );
    }
  }

  return out;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface ParsedPatchLine {
  hunkIndex: number;
  side: DiffSide;
  line: number;
  text: string;
}

/** Walk one file's unified-diff patch and yield each addition/deletion/context line with its coordinates. */
function* iteratePatchLines(patch: string): Generator<ParsedPatchLine> {
  let hunkIndex = -1;
  let oldCursor = 0;
  let newCursor = 0;

  for (const rawLine of patch.split("\n")) {
    const headerMatch = HUNK_HEADER_RE.exec(rawLine);
    if (headerMatch) {
      hunkIndex += 1;
      oldCursor = Number(headerMatch[1]);
      newCursor = Number(headerMatch[2]);
      continue;
    }

    if (hunkIndex < 0) {
      continue;
    }

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      yield { hunkIndex, side: "new", line: newCursor, text: rawLine.slice(1) };
      newCursor += 1;
      continue;
    }

    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      yield { hunkIndex, side: "old", line: oldCursor, text: rawLine.slice(1) };
      oldCursor += 1;
      continue;
    }

    if (rawLine.startsWith(" ")) {
      yield { hunkIndex, side: "new", line: newCursor, text: rawLine.slice(1) };
      oldCursor += 1;
      newCursor += 1;
      continue;
    }

    if (rawLine.startsWith("\\")) {
      continue;
    }
  }
}

function pushFileMatches(
  out: FileSearchMatch[],
  haystack: string,
  needle: string,
  base: Omit<FileSearchMatch, "columnStart" | "columnEnd">,
) {
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) {
      return;
    }

    out.push({ ...base, columnStart: index, columnEnd: index + needle.length });
    cursor = index + needle.length;
  }
}

/** Walk every file's patch and produce all matches in stream order (file order, then in-file). */
export function findMatchesInFiles(
  files: DiffFile[],
  rawQuery: string,
  options: FindSearchMatchesOptions = {},
): FileSearchMatch[] {
  if (!rawQuery) {
    return [];
  }

  const caseSensitive = options.caseSensitive ?? false;
  const needle = caseSensitive ? rawQuery : rawQuery.toLowerCase();
  const out: FileSearchMatch[] = [];

  for (const file of files) {
    if (!file.patch) {
      continue;
    }

    for (const parsed of iteratePatchLines(file.patch)) {
      const haystack = caseSensitive ? parsed.text : parsed.text.toLowerCase();
      pushFileMatches(out, haystack, needle, {
        fileId: file.id,
        filePath: file.path,
        hunkIndex: parsed.hunkIndex,
        side: parsed.side,
        line: parsed.line,
      });
    }
  }

  return out;
}

/** Advance a match cursor with wrap-around. Empty match lists collapse to -1. */
export function moveSearchCursor(matchCount: number, current: number, delta: 1 | -1): number {
  if (matchCount <= 0) {
    return -1;
  }

  const safeCurrent = current < 0 ? (delta === 1 ? -1 : 0) : current;
  const next = (safeCurrent + delta + matchCount) % matchCount;
  return next;
}
