import type { HistoryGraphRow } from "../../core/history/types";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import {
  formatHistoryDecorations,
  renderHistoryContinuation,
  renderHistoryGraph,
} from "../history/staticProjection";
import { fitText, measureTextWidth } from "../lib/text";
import type { LogPresentation } from "./controller";
import { formatHistoryRelativeTime, resolveHistoryAuthorLabel } from "./formatting";

export type LogResponsiveDensity = "wide" | "medium" | "narrow";

export interface LogResponsiveLayout {
  density: LogResponsiveDensity;
  rowHeight: 3;
  bodyHeight: number;
}

export interface LogResponsiveRow {
  graph: string;
  continuation: string;
  graphWidth: number;
  leftWidth: number;
  rightWidth: number;
  columnGap: number;
  title: string;
  author: string;
  relativeTime: string;
  metadata: string;
  displayId: string;
  copyIcon: string;
  secondary: string;
}

/** Derive one information-density policy from the actual terminal dimensions. */
export function resolveLogResponsiveLayout(width: number, height: number): LogResponsiveLayout {
  const safeWidth = Math.max(1, width);
  return {
    density: safeWidth >= 96 ? "wide" : safeWidth >= 60 ? "medium" : "narrow",
    rowHeight: 3,
    // Reserve one row each for the menu, its breathing room, and the status bar.
    bodyHeight: Math.max(1, height - 3),
  };
}

/** Project one commit into left/right responsive columns using terminal display-cell widths. */
export function projectResponsiveLogRow({
  row,
  presentation,
  layout,
  width,
  now,
}: {
  row: HistoryGraphRow;
  presentation: LogPresentation;
  layout: LogResponsiveLayout;
  width: number;
  now?: number;
}): LogResponsiveRow {
  const contentWidth = Math.max(1, width - 2);
  const rawGraph = presentation.graph
    ? renderHistoryGraph(row, !presentation.unicode)
    : presentation.unicode
      ? "│"
      : "|";
  const rawContinuation = presentation.graph
    ? renderHistoryContinuation(row, !presentation.unicode)
    : rawGraph;
  const safeId = sanitizeTerminalLine(row.commit.displayId).replaceAll("\t", " ");
  const maxIdWidth = Math.max(
    1,
    Math.min(measureTextWidth(safeId), Math.floor(contentWidth * 0.35)),
  );
  const displayId = fitText(safeId, maxIdWidth, "…");
  const copyIcon = presentation.unicode ? "⧉" : "c";
  const rawSecondary =
    presentation.decorations && layout.density === "wide"
      ? formatHistoryDecorations(row).trim()
      : "";
  const idActionWidth = measureTextWidth(displayId) + 1 + measureTextWidth(copyIcon);
  const secondary = fitText(rawSecondary, Math.max(idActionWidth, Math.floor(contentWidth * 0.35)));
  const rightWidth = Math.max(idActionWidth, measureTextWidth(secondary));
  const minimumLeftWidth = Math.min(12, Math.max(1, contentWidth - rightWidth));
  const desiredGap = contentWidth > rightWidth + minimumLeftWidth ? 2 : 0;
  const maximumGraphWidth = Math.max(0, contentWidth - rightWidth - minimumLeftWidth - desiredGap);
  const graphContentWidth = Math.max(0, maximumGraphWidth - 2);
  const graph = graphContentWidth > 0 ? fitText(rawGraph, graphContentWidth, "…") : "";
  const continuation =
    graphContentWidth > 0 ? fitText(rawContinuation, graphContentWidth, "…") : "";
  const graphWidth = graph
    ? Math.min(
        maximumGraphWidth,
        Math.max(measureTextWidth(graph), measureTextWidth(continuation)) + 2,
      )
    : 0;
  const columnGap = contentWidth > graphWidth + rightWidth ? desiredGap : 0;
  const leftWidth = Math.max(1, contentWidth - graphWidth - rightWidth - columnGap);
  const author = presentation.author
    ? sanitizeTerminalLine(resolveHistoryAuthorLabel(row.commit)).replaceAll("\t", " ")
    : "";
  const relativeTime = presentation.date
    ? formatHistoryRelativeTime(row.commit.authoredAt, now)
    : "";
  const metadata = fitText([author, relativeTime].filter(Boolean).join(" · "), leftWidth);
  const separatorIndex = metadata.indexOf(" · ");
  const fittedAuthor = author
    ? separatorIndex >= 0
      ? metadata.slice(0, separatorIndex)
      : metadata
    : "";
  const fittedRelativeTime = relativeTime
    ? separatorIndex >= 0
      ? metadata.slice(separatorIndex + 3)
      : author
        ? ""
        : metadata
    : "";
  return {
    graph,
    continuation,
    graphWidth,
    leftWidth,
    rightWidth,
    columnGap,
    title: fitText(sanitizeTerminalLine(row.commit.subject).replaceAll("\t", " "), leftWidth),
    author: fittedAuthor,
    relativeTime: fittedRelativeTime,
    metadata,
    displayId,
    copyIcon,
    secondary: fitText(secondary, rightWidth),
  };
}
