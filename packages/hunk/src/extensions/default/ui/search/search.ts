/**
 * Pure search primitives: patch text in, ordered jump targets out.
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

/** One matching line inside a hunk, as it is reported back to the user. */
export interface SearchMatchLine {
  /** Hunk-local position, counted over the hunk's rendered lines. */
  offset: number;
  /** The first match's extent within `text`, so the diff can mark it. */
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
 * One place the review can jump to.
 *
 * Hunk-granular stepping with a line-exact landing: collapsing every match
 * inside a hunk into one target is what keeps `n` visibly moving on every
 * press, while `line` carries the first match's own position so the jump lands
 * on it rather than on the hunk's anchor.
 */
export interface SearchTarget {
  fileId: string;
  path: string;
  hunkIndex: number;
  /** The first matching line in this hunk — what the toast quotes. */
  line: SearchMatchLine;
  /** How many lines in this hunk matched, including `line`. */
  count: number;
}

/**
 * Locate every non-overlapping match on a line, or report why compilation failed.
 *
 * `locate` returns ranges in text order, or an empty array for a non-matching line.
 * The diff marks every range; hunk-granular targets keep only the first range of
 * their first matching line. Zero-width regex matches mark one character.
 */
export type CompiledQuery =
  | { ok: true; locate: (line: string) => MatchRange[] }
  | { ok: false; error: string };

/** One parsed patch line, tagged with the hunk it belongs to. */
interface PatchLine {
  hunkIndex: number;
  offset: number;
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

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      hunkIndex += 1;
      offset = 0;
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

    if (marker === "-") {
      lines.push({ hunkIndex, offset, lineNumber: oldLine, side: "old", text });
      if (oldLine !== null) oldLine += 1;
    } else if (marker === "+") {
      lines.push({ hunkIndex, offset, lineNumber: newLine, side: "new", text });
      if (newLine !== null) newLine += 1;
    } else if (marker === " " || marker === undefined) {
      // An empty line in a patch is an unmarked context line.
      lines.push({ hunkIndex, offset, lineNumber: newLine, side: "new", text: text ?? "" });
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
    } else {
      // Not a body line (a stray header inside patch text): skip without
      // advancing either counter.
      continue;
    }

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
 * Build every jump target for one compiled query, in review-stream order.
 *
 * Files are walked in changeset order and hunks in render order, so the
 * resulting array is already the order `n` should visit — no sorting, and no
 * second notion of "next" to keep in step with the review stream.
 */
export function findTargets(
  files: readonly ExtensionDiffFile[],
  locate: (line: string) => MatchRange[],
): SearchTarget[] {
  const targets: SearchTarget[] = [];

  for (const file of files) {
    if (typeof file.patch !== "string" || file.patch.length === 0) {
      continue;
    }

    let current: SearchTarget | undefined;
    for (const line of parsePatchLines(file.patch)) {
      const matchRange = locate(line.text)[0];
      if (matchRange === undefined) {
        continue;
      }

      if (current && current.hunkIndex === line.hunkIndex) {
        current.count += 1;
        continue;
      }

      current = {
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
        count: 1,
      };
      targets.push(current);
    }
  }

  return targets;
}

/**
 * Build the diff marks for one file's matches, in source coordinates.
 *
 * Mark every occurrence, but give only the first range of the active target's
 * quoted line the `"current"` tone. Stepping stays hunk-granular, so later ranges
 * on the landed line keep the ordinary `"match"` tone.
 */
export function collectFileMatchMarks(
  file: ExtensionDiffFile,
  locate: (line: string) => MatchRange[],
  currentTarget: { fileId: string; hunkIndex: number; lineOffset: number } | null,
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
    for (const [index, range] of ranges.entries()) {
      marks.push({
        side: line.side,
        line: line.lineNumber,
        range,
        tone: isCurrent && index === 0 ? "current" : "match",
      });
    }
  }

  return marks;
}

/** Where the review is pointing, as the search compares positions. */
export interface SearchPosition {
  fileId: string | null;
  hunkIndex: number | null;
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
 * Both directions are strict: a repeat never answers with the hunk the user is
 * already on, so `n` always moves. When the current hunk is the only match, the
 * wrap brings it back around — which is why wrapping is unconditional here
 * rather than a setting.
 */
export function stepToTarget(
  targets: readonly SearchTarget[],
  fileOrder: ReadonlyMap<string, number>,
  from: SearchPosition,
  direction: SearchDirection,
): SearchStep | null {
  if (targets.length === 0) {
    return null;
  }

  const current = positionRank(fileOrder, from);
  if (current === null) {
    // No usable selection: start at whichever end the direction implies.
    return { index: direction === "forward" ? 0 : targets.length - 1, wrapped: false };
  }

  if (direction === "forward") {
    const index = targets.findIndex((target) => targetRank(fileOrder, target) > current);
    return index === -1 ? { index: 0, wrapped: true } : { index, wrapped: false };
  }

  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const target = targets[index];
    if (target && targetRank(fileOrder, target) < current) {
      return { index, wrapped: false };
    }
  }

  return { index: targets.length - 1, wrapped: true };
}

/** Order files by their changeset position so positions compare as one number. */
export function buildFileOrder(files: readonly ExtensionDiffFile[]): Map<string, number> {
  return new Map(files.map((file, index) => [file.id, index]));
}

/**
 * Collapse a (file, hunk) pair into one comparable rank.
 *
 * Hunk counts per file are unbounded in principle, so the rank is a pair
 * flattened with a large stride rather than an arithmetic trick — the stride is
 * only ever compared, never decoded.
 */
const HUNK_RANK_STRIDE = 1_000_000;

function targetRank(fileOrder: ReadonlyMap<string, number>, target: SearchTarget) {
  const file = fileOrder.get(target.fileId) ?? 0;
  return file * HUNK_RANK_STRIDE + target.hunkIndex;
}

function positionRank(fileOrder: ReadonlyMap<string, number>, position: SearchPosition) {
  if (position.fileId === null) {
    return null;
  }

  const file = fileOrder.get(position.fileId);
  if (file === undefined) {
    return null;
  }

  // A file with no selected hunk ranks just before its first hunk, so a forward
  // search from a freshly opened file finds that file's own first match.
  return file * HUNK_RANK_STRIDE + (position.hunkIndex ?? -1);
}
