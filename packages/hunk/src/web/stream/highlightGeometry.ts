/**
 * Measures where agent attention marks fall on the lines Pierre drew.
 *
 * An agent highlight names a `[start, end)` character range on one line of one side
 * (`ReviewAgentHighlightV1`). Pierre has no decoration hook for character ranges, so the page
 * finds the drawn line by its number and side and asks the browser where those characters
 * are, through a DOM `Range` over the line's text, then paints boxes over them. Lines Pierre
 * did not draw (inside a collapsed gap) get no box until the gap opens, as in the terminal.
 */
import type {
  ReviewAgentHighlightToneV1,
  ReviewAgentHighlightV1,
} from "../../session/reviewSharedState";

/** One painted box, relative to the top-left of the file's drawing. */
export interface ReviewHighlightBox {
  tone: ReviewAgentHighlightToneV1;
  side: "old" | "new";
  line: number;
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Whether one drawn content line belongs to a side, in either layout. */
function lineOnSide(element: Element, side: "old" | "new", layout: "split" | "unified") {
  if (layout === "split") {
    const column = element.closest("[data-code]");
    if (!column) return false;
    if (column.hasAttribute("data-deletions")) return side === "old";
    if (column.hasAttribute("data-additions")) return side === "new";
    // A column that names neither side is the new side's, Pierre's order for one-sided files.
    return side === "new";
  }
  // Unified rows number deletions by their old line and everything else by its new line.
  const type = element.getAttribute("data-line-type") ?? "";
  return side === "old" ? type.includes("deletion") : !type.includes("deletion");
}

/** Text nodes under one element, in order. */
function textNodes(element: Element) {
  const nodes: Text[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/** The DOM position of one character offset within a line's text nodes. */
function positionAt(nodes: readonly Text[], offset: number) {
  let remaining = offset;
  for (const node of nodes) {
    const length = node.data.length;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
  }
  const last = nodes[nodes.length - 1];
  return last ? { node: last, offset: last.data.length } : undefined;
}

/** Measure every mark that lands on a drawn line of one mounted file. */
export function measureAgentHighlights(
  host: HTMLElement,
  highlights: readonly ReviewAgentHighlightV1[],
  layout: "split" | "unified",
): ReviewHighlightBox[] {
  if (highlights.length === 0) return [];
  const root = host.querySelector("diffs-container")?.shadowRoot;
  if (!root) return [];
  const origin = host.getBoundingClientRect();
  const boxes: ReviewHighlightBox[] = [];
  for (const mark of highlights) {
    const line = Array.from(root.querySelectorAll(`[data-line="${mark.line}"]`)).find(
      (element) => element.closest("[data-code]") && lineOnSide(element, mark.side, layout),
    );
    if (!line) continue;
    const nodes = textNodes(line);
    const start = positionAt(nodes, mark.start);
    const end = positionAt(nodes, mark.end);
    if (!start || !end) continue;
    const range = line.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width === 0) continue;
      boxes.push({
        tone: mark.tone,
        side: mark.side,
        line: mark.line,
        top: rect.top - origin.top,
        left: rect.left - origin.left,
        width: rect.width,
        height: rect.height,
      });
    }
  }
  return boxes;
}
