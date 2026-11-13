/**
 * Collapsed-gap addressing: which file lines an expandable gap covers.
 *
 * A gap is addressed by a stable id (`before:<hunkIndex>` / `trailing:<hunkIndex>`) and
 * resolves to one inclusive line range per side. Renderers draw those ranges, expansion
 * slices source text with them, and note validation accepts or rejects a line against
 * them — so all three must resolve the same address (`docs/browser-review-seam-audit.md`,
 * A1/A2/A5).
 *
 * The input is the parsed diff geometry rather than a projected `ReviewFileV1`, so the
 * terminal's row builder can resolve an address without projecting a document first;
 * `reviewGapSourceForFile` adapts a semantic file onto the same shape.
 */
import { normalizedReviewSourceLines, rebaseReviewHunk, type ReviewHunkSpan } from "./geometry";
import type {
  ReviewFileChangeKind,
  ReviewFileV1,
  ReviewHunkV1,
  ReviewLineRange,
  ReviewSide,
} from "./types";

export type ReviewGapPosition = "before" | "trailing";

export interface ReviewGapHunk extends ReviewHunkSpan {
  collapsedBefore: number;
  additionLineIndex: number;
  deletionLineIndex: number;
}

/**
 * The parsed facts gap addressing needs.
 *
 * `additionLines` / `deletionLines` are the patch's per-side line arrays; their lengths
 * are the file's line totals only when the patch is complete, which is why a partial
 * patch has no trailing gap.
 */
export interface ReviewGapSource {
  hunks: readonly ReviewGapHunk[];
  additionLines: readonly string[];
  deletionLines: readonly string[];
  isPartial: boolean;
}

export interface ReviewGapAddress {
  position: ReviewGapPosition;
  hunkIndex: number;
  oldRange: ReviewLineRange;
  newRange: ReviewLineRange;
  /** Rows the gap renders; both sides always span exactly this many lines. */
  lineCount: number;
}

/** Build the stable id of one collapsed gap inside a single file. */
export function reviewGapId(position: ReviewGapPosition, hunkIndex: number) {
  return `${position}:${hunkIndex}`;
}

/** Parse one gap id back into its position and hunk index, or undefined when malformed. */
export function parseReviewGapId(gapId: string) {
  const match = /^(before|trailing):(\d+)$/.exec(gapId);
  if (!match) {
    return undefined;
  }
  const hunkIndex = Number(match[2]);
  return Number.isSafeInteger(hunkIndex)
    ? { position: match[1] as ReviewGapPosition, hunkIndex }
    : undefined;
}

/** Adapt one projected semantic file onto the geometry gap addressing reads. */
export function reviewGapSourceForFile(file: ReviewFileV1): ReviewGapSource {
  return {
    hunks: file.hunks,
    additionLines: file.additionLines,
    deletionLines: file.deletionLines,
    isPartial: file.flags.partial,
  };
}

/**
 * The gap of unchanged lines the patch omitted before one hunk.
 *
 * Each side's gap ends at the last line before the hunk's own content. A side with rows
 * ends one line before its start; a side with none — the old side of a pure insertion,
 * the new side of a pure deletion — is positioned *at* that last line, so the gap ends
 * there. Getting this wrong shifts every expanded line label on that side by one, which
 * is exactly what the terminal's own copy did (A1).
 *
 * The gap's length is the parser's `collapsedBefore`. Returns undefined when there is no
 * gap, or when its start would fall outside the file.
 */
export function reviewLeadingGap(
  source: ReviewGapSource,
  hunkIndex: number,
): ReviewGapAddress | undefined {
  const hunk = source.hunks[hunkIndex];
  if (!hunk || hunk.collapsedBefore <= 0) {
    return undefined;
  }

  const oldEnd = hunk.deletionStart - (hunk.deletionCount > 0 ? 1 : 0);
  const newEnd = hunk.additionStart - (hunk.additionCount > 0 ? 1 : 0);
  const oldStart = oldEnd - hunk.collapsedBefore + 1;
  const newStart = newEnd - hunk.collapsedBefore + 1;
  if (oldStart <= 0 || newStart <= 0) {
    return undefined;
  }

  return {
    position: "before",
    hunkIndex,
    oldRange: [oldStart, oldEnd],
    newRange: [newStart, newEnd],
    lineCount: hunk.collapsedBefore,
  };
}

/**
 * The gap of unchanged lines after the file's last hunk.
 *
 * Length comes from what each side's line array has left over once the last hunk is
 * consumed, and the two leftovers must agree because the gap renders as paired rows. A
 * partial patch has no authoritative totals, so it has no trailing gap.
 *
 * Known limitation (A2): a last hunk with a zero-count side leaves the two leftovers one
 * apart, so no trailing gap is offered even though the file has unchanged lines after
 * the hunk. Every consumer agrees on hiding it — correcting the count changes what the
 * terminal renders and is staged as its own change.
 */
export function reviewTrailingGap(source: ReviewGapSource): ReviewGapAddress | undefined {
  const hunkIndex = source.hunks.length - 1;
  const hunk = source.hunks[hunkIndex];
  if (!hunk || source.isPartial) {
    return undefined;
  }

  const oldCount = source.deletionLines.length - (hunk.deletionLineIndex + hunk.deletionCount);
  const newCount = source.additionLines.length - (hunk.additionLineIndex + hunk.additionCount);
  if (oldCount !== newCount || oldCount <= 0) {
    return undefined;
  }

  const oldStart = hunk.deletionStart + hunk.deletionCount;
  const newStart = hunk.additionStart + hunk.additionCount;
  return {
    position: "trailing",
    hunkIndex,
    oldRange: [oldStart, oldStart + oldCount - 1],
    newRange: [newStart, newStart + newCount - 1],
    lineCount: oldCount,
  };
}

/** Resolve one gap id against the current geometry, or undefined when it addresses nothing. */
export function reviewGapAddress(
  source: ReviewGapSource,
  gapId: string,
): ReviewGapAddress | undefined {
  const parsed = parseReviewGapId(gapId);
  if (!parsed) {
    return undefined;
  }
  if (parsed.position === "before") {
    return reviewLeadingGap(source, parsed.hunkIndex);
  }
  const trailing = reviewTrailingGap(source);
  return trailing?.hunkIndex === parsed.hunkIndex ? trailing : undefined;
}

/**
 * A caller's claim that one line it is addressing came from an expanded gap.
 *
 * A line inside a gap is not in the patch at all, so nothing about the file proves it
 * exists: a surface that expanded a gap and then addressed a line in it has to say which
 * gap, and which content it was reading. The identity is what makes the claim checkable
 * across a reload — the same gap over different source text is a different set of lines.
 */
export interface ReviewExpandedLineClaim {
  gapId: string;
  side: ReviewSide;
  line: number;
  /** Identity of the source the caller expanded; must still be the file's own. */
  sourceIdentity: string;
}

/**
 * Resolve one expanded-line claim against the file's current geometry.
 *
 * Returns the gap the line belongs to, or undefined when the claim does not hold — the
 * gap is gone, the line falls outside it, or the source behind it has been replaced. The
 * gap's `hunkIndex` is what an anchor uses as the owning hunk, so a note on an expanded
 * line stays attached to the hunk the reviewer was reading (`docs/browser-review-seam-
 * audit.md`, B10/D3).
 */
export function resolveReviewExpandedLine(
  file: ReviewFileV1,
  claim: ReviewExpandedLineClaim,
): ReviewGapAddress | undefined {
  if (file.sourceIdentity === undefined || file.sourceIdentity !== claim.sourceIdentity) {
    return undefined;
  }
  const address = reviewGapAddress(reviewGapSourceForFile(file), claim.gapId);
  if (!address) {
    return undefined;
  }
  const [start, end] = claim.side === "old" ? address.oldRange : address.newRange;
  return claim.line >= start && claim.line <= end ? address : undefined;
}

/**
 * Which side's full source text fills this file's expanded gaps.
 *
 * A deleted file has no new side to read, so its gaps come from the old one. Both ranges
 * of a gap stay addressable either way; this only decides where the text is read from.
 */
export function reviewExpansionSide(changeKind: ReviewFileChangeKind): ReviewSide {
  return changeKind === "deleted" ? "old" : "new";
}

/** One expanded gap and the source lines that fill it. */
export interface ReviewExpandedGapContent {
  address: ReviewGapAddress;
  /** Exactly `address.lineCount` lines of the expansion side's source, in file order. */
  lines: readonly string[];
}

/**
 * Resolve which expanded gaps can be filled from one side's full source text.
 *
 * Every id is resolved through `reviewGapAddress` and sliced from the expansion side with
 * `normalizedReviewSourceLines`, so a renderer that draws whole files fills exactly the
 * lines the terminal's rows show. A gap the source does not fully cover is left out rather
 * than filled short.
 */
export function reviewExpandedGapContents(
  file: ReviewFileV1,
  expandedGapIds: readonly string[],
  sourceText: string,
): ReviewExpandedGapContent[] {
  const source = reviewGapSourceForFile(file);
  const side = reviewExpansionSide(file.changeKind);
  const sourceLines = normalizedReviewSourceLines(sourceText);
  const contents: ReviewExpandedGapContent[] = [];
  for (const gapId of new Set(expandedGapIds)) {
    const address = reviewGapAddress(source, gapId);
    if (!address) continue;
    const [start, end] = side === "old" ? address.oldRange : address.newRange;
    const lines = sourceLines.slice(start - 1, end);
    if (lines.length === address.lineCount) {
      contents.push({ address, lines });
    }
  }
  return contents;
}

/** One context block of `lines` rows, before re-basing gives it its indices. */
function contextBlock(lines: number) {
  return { type: "context" as const, lines, additionLineIndex: 0, deletionLineIndex: 0 };
}

/**
 * Fold expanded gaps into a file's hunks as context, for a renderer that draws whole files.
 *
 * The terminal draws expanded gap rows itself; a renderer that takes one parsed file and
 * draws all of it (Pierre in the browser) needs the expansion expressed as hunk geometry
 * instead. A leading gap becomes a context block at the start of the hunk after it and a
 * trailing gap one at the end of the last hunk, with the hunk's starts, counts, and row
 * spans widened by the gap and its collapsed count cleared. Row totals do not change: a
 * collapsed gap's rows are already counted in the file's split and unified totals.
 *
 * A complete patch already holds every line, so only the hunk moves. A partial patch holds
 * just the patch's lines, so the gap's lines are inserted into both line arrays where the
 * hunk's content begins and every later hunk is re-based past them with `rebaseReviewHunk`.
 *
 * The result is a render view of the same file — key and identities unchanged — never a
 * publishable file.
 */
export function reviewFileWithExpandedGaps(
  file: ReviewFileV1,
  expanded: readonly ReviewExpandedGapContent[],
): ReviewFileV1 {
  if (expanded.length === 0) {
    return file;
  }
  const before = new Map<number, ReviewExpandedGapContent>();
  let trailing: ReviewExpandedGapContent | undefined;
  for (const content of expanded) {
    if (content.address.position === "before") before.set(content.address.hunkIndex, content);
    else trailing = content;
  }

  const partial = file.flags.partial;
  const terminated = (line: string) => line.endsWith("\n");
  const terminator =
    file.additionLines.some(terminated) || file.deletionLines.some(terminated) ? "\n" : "";
  const additionLines: string[] = partial ? [] : file.additionLines;
  const deletionLines: string[] = partial ? [] : file.deletionLines;
  let copiedAdditions = 0;
  let copiedDeletions = 0;
  let shift = 0;
  const lastIndex = file.hunks.length - 1;

  const hunks = file.hunks.map((hunk, index) => {
    const leading = before.get(index);
    const after = index === lastIndex ? trailing : undefined;
    if (partial) {
      // Copy the patch lines up to this hunk, then insert the gap's lines where it begins.
      additionLines.push(...file.additionLines.slice(copiedAdditions, hunk.additionLineIndex));
      deletionLines.push(...file.deletionLines.slice(copiedDeletions, hunk.deletionLineIndex));
      copiedAdditions = hunk.additionLineIndex;
      copiedDeletions = hunk.deletionLineIndex;
      if (leading) {
        // Parsed lines keep their terminators; inserted ones follow the file's convention so
        // a renderer that joins lines cannot run two of them together.
        const inserted = leading.lines.map((line) => `${line}${terminator}`);
        additionLines.push(...inserted);
        deletionLines.push(...inserted);
      }
    }
    if (!leading && !after && shift === 0) {
      return hunk;
    }

    const leadingCount = leading?.address.lineCount ?? 0;
    const trailingCount = after?.address.lineCount ?? 0;
    // A complete patch holds line N of each side at index N - 1, so a widened hunk starts at
    // its gap's first line; a partial patch had the gap inserted at the hunk's old origin.
    const origins =
      leading && !partial
        ? {
            additionLineIndex: leading.address.newRange[0] - 1,
            deletionLineIndex: leading.address.oldRange[0] - 1,
          }
        : {
            additionLineIndex: hunk.additionLineIndex + shift,
            deletionLineIndex: hunk.deletionLineIndex + shift,
          };
    if (partial) shift += leadingCount;
    const widened: ReviewHunkV1 = {
      ...hunk,
      hunkContent: [
        ...(leading ? [contextBlock(leadingCount)] : []),
        ...hunk.hunkContent,
        ...(after ? [contextBlock(trailingCount)] : []),
      ],
      collapsedBefore: hunk.collapsedBefore - leadingCount,
      // The gap's first line on each side, which also corrects a side with no rows of its
      // own: such a side is positioned at the line before it, not on it.
      additionStart: leading ? leading.address.newRange[0] : hunk.additionStart,
      deletionStart: leading ? leading.address.oldRange[0] : hunk.deletionStart,
      additionCount: hunk.additionCount + leadingCount + trailingCount,
      deletionCount: hunk.deletionCount + leadingCount + trailingCount,
      splitLineStart: hunk.splitLineStart - leadingCount,
      unifiedLineStart: hunk.unifiedLineStart - leadingCount,
      splitLineCount: hunk.splitLineCount + leadingCount + trailingCount,
      unifiedLineCount: hunk.unifiedLineCount + leadingCount + trailingCount,
    };
    return rebaseReviewHunk(widened, origins).hunk;
  });

  if (partial) {
    additionLines.push(...file.additionLines.slice(copiedAdditions));
    deletionLines.push(...file.deletionLines.slice(copiedDeletions));
  }
  return { ...file, hunks, additionLines, deletionLines };
}
