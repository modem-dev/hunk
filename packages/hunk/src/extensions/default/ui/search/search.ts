/**
 * Pure search primitives: patch text in, ordered jump targets out.
 *
 * Every occurrence is its own target, ordered the way the review draws it for the
 * active layout, so stepping with `n` only moves up the screen when it wraps.
 *
 * Everything here is a derivation of the changeset the host already handed the
 * extension, so it is testable without a terminal, a host, or a review. The
 * stateful half of the feature lives in `session.ts`.
 */
import type { ExtensionDiffFile, ExtensionLineHighlight } from "../../../../extension-api/types";

/** How a query string is interpreted. */
export type SearchMode = "literal" | "regex";

/** Which way a repeat search walks the target list. */
export type SearchDirection = "forward" | "backward";

/** Where one match sits inside a line: `[start, end)` in UTF-16 code units. */
export type MatchRange = readonly [number, number];

/** Which concrete layout the review is drawing, as the search orders lines. */
export type SearchLayout = "split" | "unified";

/** One matching line inside a hunk, as it is reported back to the user. */
export interface SearchMatchLine {
  /** Hunk-local position, counted over the hunk's rendered lines. */
  offset: number;
  /** This occurrence's extent within `text`, so the diff can mark it. */
  matchRange: MatchRange;
  /**
   * Line number on `side`, or `null` when the patch carried no usable numbers.
   */
  lineNumber: number | null;
  side: "old" | "new";
  /** The line's text with its diff marker stripped. */
  text: string;
}

/**
 * One place the review can jump to: a single match occurrence.
 *
 * Several occurrences can share a line or a hunk; `rank` orders them all the way
 * the active layout draws them.
 */
export interface SearchTarget {
  fileId: string;
  path: string;
  hunkIndex: number;
  /** The line holding this occurrence, with `matchRange` set to its extent. */
  line: SearchMatchLine;
  /** `[fileIndex, hunkIndex, ...lineOrderKey, matchStart]`, compared lexicographically. */
  rank: readonly number[];
}

/**
 * Locate every non-overlapping match on a line, or report why compilation failed.
 *
 * `locate` returns ranges in text order, or an empty array for a non-matching line.
 * The diff marks every range and each range is its own target. Zero-width regex matches mark one
 * character.
 */
export type CompiledQuery =
  | { ok: true; locate: (line: string) => MatchRange[] }
  | { ok: false; error: string };

/** One parsed patch line, tagged with the hunk it belongs to. */
export interface PatchLine {
  hunkIndex: number;
  offset: number;
  kind: "context" | "deletion" | "addition";
  /** Hunk-local index of the context run or change block holding this line. */
  group: number;
  /** Position among lines of the same kind within the group. */
  groupIndex: number;
  lineNumber: number | null;
  side: "old" | "new";
  text: string;
}

/**
 * Compile a user query into a line match locator.
 *
 * Smart case in both modes: an all-lowercase query is case-insensitive, and any
 * uppercase character makes the whole query case-sensitive — the convention
 * `less -I`, vim, and ripgrep users already have in their fingers.
 */
export function compileQuery(query: string, mode: SearchMode): CompiledQuery {
  if (query.trim().length === 0) {
    return { ok: false, error: "empty search" };
  }

  const caseSensitive = query !== query.toLowerCase();

  if (mode === "regex") {
    try {
      const pattern = new RegExp(query, caseSensitive ? "g" : "gi");
      return {
        ok: true,
        locate: (line) => {
          const ranges: MatchRange[] = [];
          pattern.lastIndex = 0;
          let found: RegExpExecArray | null;
          while ((found = pattern.exec(line)) !== null) {
            // Give zero-width matches a visible character and advance past it
            // so the next match cannot overlap or loop at the same position.
            const end = found.index + Math.max(found[0].length, 1);
            ranges.push([found.index, end]);
            pattern.lastIndex = end;
          }
          return ranges;
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  return {
    ok: true,
    locate: (line) => {
      const text = caseSensitive ? line : line.toLowerCase();
      const ranges: MatchRange[] = [];
      let index = text.indexOf(needle);
      while (index !== -1) {
        const end = index + needle.length;
        ranges.push([index, end]);
        index = text.indexOf(needle, end);
      }
      return ranges;
    },
  };
}

/** Parse one unified-diff patch into its searchable lines, hunk by hunk. */
export function parsePatchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let hunkIndex = -1;
  let offset = 0;
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let group = -1;
  let groupKind: "context" | "change" | null = null;
  const counts = { context: 0, deletion: 0, addition: 0 };

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      hunkIndex += 1;
      offset = 0;
      group = -1;
      groupKind = null;
      const ranges = readHunkStarts(raw);
      oldLine = ranges.oldStart;
      newLine = ranges.newStart;
      continue;
    }

    // Everything before the first `@@` is file header noise (`diff --git`,
    // `index`, `---`, `+++`), and `\ No newline at end of file` is a marker
    // rather than content.
    if (hunkIndex < 0 || raw.startsWith("\\")) {
      continue;
    }

    const marker = raw[0];
    const text = raw.slice(1);
    const kind =
      marker === "-"
        ? "deletion"
        : marker === "+"
          ? "addition"
          : marker === " " || marker === undefined
            ? "context"
            : null;
    if (kind === null) {
      // Not a body line (a stray header inside patch text): skip without
      // advancing either counter.
      continue;
    }

    // Mirror Pierre: every consecutive `-`/`+` line joins one change group, and a
    // context line starts a new group.
    const lineGroupKind = kind === "context" ? "context" : "change";
    if (lineGroupKind !== groupKind) {
      group += 1;
      groupKind = lineGroupKind;
      counts.context = counts.deletion = counts.addition = 0;
    }
    const groupIndex = counts[kind]++;

    const side = kind === "deletion" ? "old" : "new";
    lines.push({
      hunkIndex,
      offset,
      kind,
      group,
      groupIndex,
      lineNumber: side === "old" ? oldLine : newLine,
      side,
      // An empty line in a patch is an unmarked context line.
      text: text ?? "",
    });
    if (kind !== "addition" && oldLine !== null) oldLine += 1;
    if (kind !== "deletion" && newLine !== null) newLine += 1;

    offset += 1;
  }

  return lines;
}

/** Read the old/new starting line numbers out of an `@@` header. */
function readHunkStarts(header: string): { oldStart: number | null; newStart: number | null } {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!match) {
    return { oldStart: null, newStart: null };
  }

  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

/**
 * Hunk-local screen order of one line: unified stacks a change block's deletions above its
 * additions; split pairs them row by row, old half first.
 */
export function lineOrderKey(
  line: Pick<PatchLine, "kind" | "group" | "groupIndex">,
  layout: SearchLayout,
): [number, number, number] {
  const addition = line.kind === "addition" ? 1 : 0;
  return layout === "unified"
    ? [line.group, addition, line.groupIndex]
    : [line.group, line.groupIndex, addition];
}

/** Compare two ranks lexicographically; a shorter rank sorts before its extensions. */
export function compareRanks(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return a.length - b.length;
}

/**
 * Build every jump target for one compiled query, one per match occurrence.
 *
 * Targets are sorted by rank, so the array is already the order `n` visits: files in
 * changeset order, hunks in render order, then lines as `layout` draws them.
 */
export function findTargets(
  files: readonly ExtensionDiffFile[],
  locate: (line: string) => MatchRange[],
  layout: SearchLayout,
): SearchTarget[] {
  const targets: SearchTarget[] = [];

  for (const [fileIndex, file] of files.entries()) {
    if (typeof file.patch !== "string" || file.patch.length === 0) {
      continue;
    }

    for (const line of parsePatchLines(file.patch)) {
      for (const matchRange of locate(line.text)) {
        targets.push({
          fileId: file.id,
          path: file.path,
          hunkIndex: line.hunkIndex,
          line: {
            offset: line.offset,
            matchRange,
            lineNumber: line.lineNumber,
            side: line.side,
            text: line.text,
          },
          rank: [fileIndex, line.hunkIndex, ...lineOrderKey(line, layout), matchRange[0]],
        });
      }
    }
  }

  return targets.sort((a, b) => compareRanks(a.rank, b.rank));
}

/**
 * Build the diff marks for one file's matches, in source coordinates.
 *
 * Mark every occurrence, and give only the active target's own range the
 * `"current"` tone.
 */
export function collectFileMatchMarks(
  file: ExtensionDiffFile,
  locate: (line: string) => MatchRange[],
  currentTarget: {
    fileId: string;
    hunkIndex: number;
    lineOffset: number;
    matchStart: number;
  } | null,
): ExtensionLineHighlight[] {
  if (typeof file.patch !== "string" || file.patch.length === 0) {
    return [];
  }

  const marks: ExtensionLineHighlight[] = [];
  for (const line of parsePatchLines(file.patch)) {
    // A line the patch numbers ambiguously cannot be addressed; skip its mark
    // rather than guessing — the hunk jump still lands nearby.
    if (line.lineNumber === null) {
      continue;
    }
    const ranges = locate(line.text);
    const isCurrent =
      currentTarget !== null &&
      currentTarget.fileId === file.id &&
      currentTarget.hunkIndex === line.hunkIndex &&
      currentTarget.lineOffset === line.offset;
    for (const range of ranges) {
      marks.push({
        side: line.side,
        line: line.lineNumber,
        range,
        tone: isCurrent && range[0] === currentTarget.matchStart ? "current" : "match",
      });
    }
  }

  return marks;
}

/** The result of stepping through the target list. */
export interface SearchStep {
  index: number;
  /** True when the step ran off one end and continued from the other. */
  wrapped: boolean;
}

/**
 * Find the next target in `direction`, wrapping like `less` does.
 *
 * `from` is a rank prefix: a hunk `[file, hunk]`, a line `[file, hunk, ...key]`, or
 * an exact target rank. Targets compare by their rank truncated to that length, so
 * both directions are strict at the chosen granularity and a repeat never answers
 * with the position it started from. When nothing lies beyond, the wrap brings the
 * list back around — which is why wrapping is unconditional rather than a setting.
 */
export function stepToTarget(
  targets: readonly SearchTarget[],
  from: readonly number[] | null,
  direction: SearchDirection,
): SearchStep | null {
  if (targets.length === 0) {
    return null;
  }

  if (from === null) {
    // No usable selection: start at whichever end the direction implies.
    return { index: direction === "forward" ? 0 : targets.length - 1, wrapped: false };
  }

  const compareToFrom = (target: SearchTarget) =>
    compareRanks(target.rank.slice(0, from.length), from);

  if (direction === "forward") {
    const index = targets.findIndex((target) => compareToFrom(target) > 0);
    return index === -1 ? { index: 0, wrapped: true } : { index, wrapped: false };
  }

  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const target = targets[index];
    if (target && compareToFrom(target) < 0) {
      return { index, wrapped: false };
    }
  }

  return { index: targets.length - 1, wrapped: true };
}
