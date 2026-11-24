import { LineDiffRangeCache, type FileDiffMetadata } from "@pierre/diffs";
import { pierreHighlightRenderOptions } from "../../../core/documents/highlightRenderOptions";
import type { HastNode } from "./highlightHast";

type LineDiffRange = readonly [start: number, end: number];

interface HighlightedHastDiffLines {
  deletionLines: Array<HastNode | undefined>;
  additionLines: Array<HastNode | undefined>;
}

const WORD_DIFF_PROPERTIES = { "data-diff-span": "" };

/** Wrap one text slice in the marker span that `collectHastHighlightRuns` reads as word diff. */
function wordDiffSpan(value: string): HastNode {
  return {
    type: "element",
    tagName: "span",
    properties: WORD_DIFF_PROPERTIES,
    children: [{ type: "text", value }],
  };
}

/**
 * Return a copy of one HAST line whose text inside `ranges` sits under word-diff marker spans.
 *
 * Columns count UTF-16 text in document order, the same projection the compact encoder uses.
 * Untouched subtrees are shared with the input.
 */
function markLineRanges(line: HastNode, ranges: readonly LineDiffRange[]) {
  let column = 0;

  const visit = (node: HastNode): HastNode[] => {
    if (node.type === "text") {
      const start = column;
      const end = start + node.value.length;
      column = end;

      const pieces: HastNode[] = [];
      let cursor = start;
      for (const [rangeStart, rangeEnd] of ranges) {
        const from = Math.max(rangeStart, cursor);
        const to = Math.min(rangeEnd, end);
        if (from >= to) continue;
        if (from > cursor)
          pieces.push({ type: "text", value: node.value.slice(cursor - start, from - start) });
        pieces.push(wordDiffSpan(node.value.slice(from - start, to - start)));
        cursor = to;
      }
      if (cursor === start) return [node];
      if (cursor < end) pieces.push({ type: "text", value: node.value.slice(cursor - start) });
      return pieces;
    }

    const children = node.children ?? [];
    let changed = false;
    const nextChildren: HastNode[] = [];
    for (const child of children) {
      const next = visit(child);
      if (next.length !== 1 || next[0] !== child) changed = true;
      nextChildren.push(...next);
    }
    return [changed ? { ...node, children: nextChildren } : node];
  };

  return visit(line)[0];
}

/**
 * Marks changed words on paired change lines of Pierre-highlighted diff output.
 *
 * Pierre 1.7 returns syntax-only HAST from `renderDiffWithHighlighter` and leaves word-diff ranges
 * to the renderer. Hunk's terminal and compact worker paths read word emphasis from
 * `data-diff-span` markers, so this restores those markers with Pierre's own range computation
 * and the same line-diff options the terminal configures for highlighting.
 */
export function markWordDiffHighlightLines<T extends HighlightedHastDiffLines>(
  metadata: FileDiffMetadata,
  highlighted: T,
  themeName: string,
): T {
  const { lineDiffType, maxLineDiffLength } = pierreHighlightRenderOptions(themeName);
  const cache = new LineDiffRangeCache(lineDiffType, maxLineDiffLength);

  for (const hunk of metadata.hunks) {
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        continue;
      }

      // Pierre pairs the i-th deletion with the i-th addition inside one change block.
      const pairs = Math.min(content.deletions, content.additions);
      for (let offset = 0; offset < pairs; offset += 1) {
        const deletionIndex = deletionLineIndex + offset;
        const additionIndex = additionLineIndex + offset;
        const deletionText = metadata.deletionLines[deletionIndex];
        const additionText = metadata.additionLines[additionIndex];
        if (deletionText === undefined || additionText === undefined) continue;

        const ranges = cache.get(deletionIndex, deletionText, additionText);
        const deletionLine = highlighted.deletionLines[deletionIndex];
        const additionLine = highlighted.additionLines[additionIndex];
        if (deletionLine && ranges.deletion.length > 0) {
          highlighted.deletionLines[deletionIndex] = markLineRanges(deletionLine, ranges.deletion);
        }
        if (additionLine && ranges.addition.length > 0) {
          highlighted.additionLines[additionIndex] = markLineRanges(additionLine, ranges.addition);
        }
      }

      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
    }
  }

  return highlighted;
}
