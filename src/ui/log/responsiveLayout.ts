import type { HistoryGraphRow } from "../../core/history/types";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../../lib/terminalText";
import {
  formatHistoryDecorations,
  renderHistoryContinuation,
  renderHistoryGraph,
} from "../history/staticProjection";
import { fitText, measureTextWidth } from "../lib/text";
import type { LogPresentation } from "./controller";

export type LogResponsiveDensity = "wide" | "medium" | "narrow";

export interface LogResponsiveLayout {
  density: LogResponsiveDensity;
  rowHeight: 3 | 4;
  bodyHeight: number;
  visibleRows: number;
  showDescription: boolean;
  showSecondary: boolean;
}

export interface LogResponsiveRow {
  graph: string;
  continuation: string;
  graphWidth: number;
  leftWidth: number;
  rightWidth: number;
  columnGap: number;
  title: string;
  description: string;
  metadata: string;
  displayId: string;
  copyIcon: string;
  secondary: string;
}

/** Derive one information-density policy from the actual terminal dimensions. */
export function resolveLogResponsiveLayout(width: number, height: number): LogResponsiveLayout {
  const safeWidth = Math.max(1, width);
  // Reserve one row each for the menu, its breathing room, and the status bar.
  const bodyHeight = Math.max(1, height - 3);
  const density: LogResponsiveDensity =
    safeWidth >= 96 ? "wide" : safeWidth >= 60 ? "medium" : "narrow";
  // Keep one graph-continuation row of breathing room between commit entries.
  const rowHeight = density === "wide" ? 4 : 3;
  return {
    density,
    rowHeight,
    bodyHeight,
    visibleRows: Math.max(1, Math.floor(bodyHeight / rowHeight)),
    showDescription: density === "wide",
    showSecondary: density === "wide",
  };
}

/** Return the first safe one-line description after the commit subject. */
function commitDescription(body: string | undefined) {
  if (!body) return "";
  return (
    sanitizeTerminalText(body, { preserveNewlines: true, preserveTabs: false })
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/** Project one commit into left/right responsive columns using terminal display-cell widths. */
export function projectResponsiveLogRow({
  row,
  presentation,
  layout,
  width,
}: {
  row: HistoryGraphRow;
  presentation: LogPresentation;
  layout: LogResponsiveLayout;
  width: number;
}): LogResponsiveRow {
  const contentWidth = Math.max(1, width - 2);
  const rawGraph = presentation.graph ? renderHistoryGraph(row, !presentation.unicode) : "";
  const rawContinuation = presentation.graph
    ? renderHistoryContinuation(row, !presentation.unicode)
    : "";
  const safeId = sanitizeTerminalLine(row.commit.displayId).replaceAll("\t", " ");
  const maxIdWidth = Math.max(
    1,
    Math.min(measureTextWidth(safeId), Math.floor(contentWidth * 0.35)),
  );
  const displayId = fitText(safeId, maxIdWidth, "…");
  const copyIcon = presentation.unicode ? "⧉" : "c";
  const secondary =
    layout.showSecondary && row.commit.parentRevisionIds.length > 1
      ? `${row.commit.parentRevisionIds.length} parents`
      : "";
  const idActionWidth = measureTextWidth(displayId) + 1 + measureTextWidth(copyIcon);
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
  const decorations = presentation.decorations ? formatHistoryDecorations(row).trim() : "";
  const metadataParts = [
    presentation.author ? sanitizeTerminalLine(row.commit.authorName).replaceAll("\t", " ") : "",
    presentation.date && layout.density !== "narrow"
      ? sanitizeTerminalLine(row.commit.authoredAt).slice(0, 10)
      : "",
    decorations,
  ].filter(Boolean);
  return {
    graph,
    continuation,
    graphWidth,
    leftWidth,
    rightWidth,
    columnGap,
    title: fitText(sanitizeTerminalLine(row.commit.subject).replaceAll("\t", " "), leftWidth),
    description: layout.showDescription
      ? fitText(commitDescription(row.commit.body), leftWidth)
      : "",
    metadata: fitText(metadataParts.join(" · "), leftWidth),
    displayId,
    copyIcon,
    secondary,
  };
}
