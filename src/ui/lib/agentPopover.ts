import { fitText } from "./text";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Wrap plain text to a fixed terminal width, breaking long tokens when needed. */
export function wrapText(text: string, width: number) {
  if (width <= 0) {
    return [""];
  }

  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return [""];
  }

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.length > 0) {
      lines.push(current);
      current = "";
    }
  };

  for (const word of words) {
    if (word.length > width) {
      pushCurrent();
      for (let offset = 0; offset < word.length; offset += width) {
        lines.push(word.slice(offset, offset + width));
      }
      continue;
    }

    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length <= width) {
      current = next;
      continue;
    }

    pushCurrent();
    current = word;
  }

  pushCurrent();
  return lines.length > 0 ? lines : [""];
}

/** Build the framed agent-popover title shown in the card header. */
function agentPopoverTitle(noteIndex: number, noteCount: number) {
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
}: {
  locationLabel: string;
  noteCount: number;
  noteIndex: number;
  rationale?: string;
  summary: string;
  width: number;
}) {
  const innerWidth = Math.max(1, width - 4);
  const summaryLines = wrapText(summary, innerWidth);
  const rationaleLines = rationale ? wrapText(rationale, innerWidth) : [];
  const footer = fitText(locationLabel, innerWidth);
  const contentLineCount =
    1 + summaryLines.length + (rationaleLines.length > 0 ? 1 + rationaleLines.length : 0) + 1 + 1;

  return {
    title: agentPopoverTitle(noteIndex, noteCount),
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
