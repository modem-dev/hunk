import { sanitizeTerminalLine } from "../../lib/terminalText";
import { fitText, measureTextWidth, sliceTextByWidth } from "./text";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Wrap plain text to a fixed terminal-cell width, breaking long tokens when needed. */
export function wrapText(text: string, width: number) {
  if (width <= 0) {
    return [""];
  }

  const normalized = sanitizeTerminalLine(text).trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return [""];
  }

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  const pushCurrent = () => {
    if (current.length > 0) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }
  };

  for (const word of words) {
    const wordWidth = measureTextWidth(word);

    if (wordWidth > width) {
      pushCurrent();
      let offset = 0;
      while (offset < wordWidth) {
        const chunk = sliceTextByWidth(word, offset, width);
        if (chunk.width <= 0) {
          // Width is narrower than one cluster; keep the remainder on one
          // line (fitText clamps at render time) instead of dropping it.
          const rest = sliceTextByWidth(word, offset, Number.MAX_SAFE_INTEGER);
          if (rest.text.length > 0) {
            lines.push(rest.text);
          }
          break;
        }
        lines.push(chunk.text);
        offset += chunk.width;
      }
      continue;
    }

    const nextWidth = current.length === 0 ? wordWidth : currentWidth + 1 + wordWidth;
    if (nextWidth <= width) {
      current = current.length === 0 ? word : `${current} ${word}`;
      currentWidth = nextWidth;
      continue;
    }

    pushCurrent();
    current = word;
    currentWidth = wordWidth;
  }

  pushCurrent();
  return lines.length > 0 ? lines : [""];
}

/** Title shown above an agent note — author name if present, otherwise "AI note", with optional "i/n" suffix. */
export function formatAgentNoteTitle(noteIndex: number, noteCount: number, author?: string) {
  if (author) {
    const safeAuthor = sanitizeTerminalLine(author);
    return noteCount > 1 ? `${safeAuthor} ${noteIndex + 1}/${noteCount}` : safeAuthor;
  }
  return noteCount > 1 ? `AI note ${noteIndex + 1}/${noteCount}` : "AI note";
}

/** Measure the content rows and total box height for one framed agent popover. */
export function buildAgentPopoverContent({
  locationLabel,
  noteCount,
  noteIndex,
  rationale,
  summary,
  width,
  author,
}: {
  locationLabel: string;
  noteCount: number;
  noteIndex: number;
  rationale?: string;
  summary: string;
  width: number;
  author?: string;
}) {
  const innerWidth = Math.max(1, width - 4);
  const summaryLines = wrapText(summary, innerWidth);
  const rationaleLines = rationale ? wrapText(rationale, innerWidth) : [];
  const footer = fitText(locationLabel, innerWidth);
  const contentLineCount =
    1 + summaryLines.length + (rationaleLines.length > 0 ? 1 + rationaleLines.length : 0) + 1 + 1;

  return {
    title: formatAgentNoteTitle(noteIndex, noteCount, author),
    summaryLines,
    rationaleLines,
    footer,
    height: contentLineCount + 2,
    innerWidth,
  };
}

/** Right-align the popover within the viewport while keeping its top edge anchored to the diff row. */
export function resolveAgentPopoverPlacement({
  anchorColumn,
  anchorRowHeight,
  anchorRowTop,
  contentHeight,
  noteHeight,
  noteWidth,
  viewportWidth,
}: {
  anchorColumn: number;
  anchorRowHeight: number;
  anchorRowTop: number;
  contentHeight: number;
  noteHeight: number;
  noteWidth: number;
  viewportWidth: number;
}) {
  const maxLeft = Math.max(1, viewportWidth - noteWidth);
  const left = maxLeft;
  const side: "right" | "left" = left >= anchorColumn ? "right" : "left";

  const preferredTop = anchorRowTop + Math.max(0, Math.floor((anchorRowHeight - 1) / 2));
  const maxTop = Math.max(0, contentHeight - noteHeight);
  const top = clamp(preferredTop, 0, maxTop);

  return { left, top, side };
}
