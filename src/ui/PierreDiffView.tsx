import { useEffect, useState } from "react";
import type { DiffFile, LayoutMode } from "../core/types";
import type { AppTheme } from "./themes";
import {
  buildSplitRows,
  buildStackRows,
  loadHighlightedDiff,
  type DiffRow,
  type HighlightedDiffCode,
  type RenderSpan,
  type SplitLineCell,
  type StackLineCell,
} from "./pierre";

function fitText(text: string, width: number) {
  if (width <= 0) {
    return "";
  }

  if (text.length <= width) {
    return text;
  }

  if (width === 1) {
    return "…";
  }

  return `${text.slice(0, width - 1)}…`;
}

function trimSpans(spans: RenderSpan[], width: number) {
  if (width <= 0) {
    return [];
  }

  const trimmed: RenderSpan[] = [];
  let remaining = width;

  for (const span of spans) {
    if (remaining <= 0) {
      break;
    }

    const text = span.text.slice(0, remaining);
    if (text.length === 0) {
      continue;
    }

    const nextSpan = {
      ...span,
      text,
    };

    const previous = trimmed.at(-1);
    if (previous && previous.fg === nextSpan.fg && previous.bg === nextSpan.bg) {
      previous.text += nextSpan.text;
    } else {
      trimmed.push(nextSpan);
    }

    remaining -= text.length;
  }

  return trimmed;
}

function marker(selected: boolean) {
  return selected ? "▌" : " ";
}

function splitCellPalette(kind: SplitLineCell["kind"], theme: AppTheme) {
  if (kind === "addition") {
    return {
      gutterBg: theme.addedBg,
      contentBg: theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: theme.removedBg,
      contentBg: theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  if (kind === "empty") {
    return {
      gutterBg: theme.lineNumberBg,
      contentBg: theme.panelAlt,
      signColor: theme.muted,
      numberColor: theme.lineNumberFg,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

function stackCellPalette(kind: StackLineCell["kind"], theme: AppTheme) {
  if (kind === "addition") {
    return {
      gutterBg: theme.addedBg,
      contentBg: theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: theme.removedBg,
      contentBg: theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

function renderSpans(spans: RenderSpan[], width: number, fallbackColor: string, keyPrefix: string) {
  const trimmed = trimSpans(spans, width);

  if (trimmed.length === 0) {
    return <text fg={fallbackColor}>{""}</text>;
  }

  return trimmed.map((span, index) => (
    <text key={`${keyPrefix}:${index}`} fg={span.fg ?? fallbackColor} bg={span.bg}>
      {span.text}
    </text>
  ));
}

function renderSplitCell(
  cell: SplitLineCell,
  width: number,
  lineNumberDigits: number,
  theme: AppTheme,
  selected: boolean,
  keyPrefix: string,
) {
  const palette = splitCellPalette(cell.kind, theme);
  const gutterWidth = Math.min(width, lineNumberDigits + 3);
  const contentWidth = Math.max(0, width - gutterWidth);

  return (
    <box key={keyPrefix} style={{ width, height: 1, flexDirection: "row" }}>
      <box
        style={{
          width: gutterWidth,
          height: 1,
          backgroundColor: selected ? theme.selectedHunk : palette.gutterBg,
        }}
      >
        <text fg={palette.numberColor}>
          {`${cell.lineNumber ? String(cell.lineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits)} ${cell.sign}`}
        </text>
      </box>
      <box
        style={{
          width: contentWidth,
          height: 1,
          backgroundColor: palette.contentBg,
        }}
      >
        {renderSpans(cell.spans, contentWidth, theme.text, `${keyPrefix}:content`)}
      </box>
    </box>
  );
}

function renderStackCell(
  cell: StackLineCell,
  width: number,
  lineNumberDigits: number,
  theme: AppTheme,
  selected: boolean,
  keyPrefix: string,
) {
  const palette = stackCellPalette(cell.kind, theme);
  const gutterWidth = Math.min(width, lineNumberDigits * 2 + 5);
  const contentWidth = Math.max(0, width - gutterWidth);

  const oldNumber = cell.oldLineNumber ? String(cell.oldLineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits);
  const newNumber = cell.newLineNumber ? String(cell.newLineNumber).padStart(lineNumberDigits, " ") : " ".repeat(lineNumberDigits);

  return (
    <box key={keyPrefix} style={{ width, height: 1, flexDirection: "row" }}>
      <box
        style={{
          width: gutterWidth,
          height: 1,
          backgroundColor: selected ? theme.selectedHunk : palette.gutterBg,
        }}
      >
        <text fg={palette.numberColor}>{`${oldNumber} ${newNumber} ${cell.sign}`}</text>
      </box>
      <box
        style={{
          width: contentWidth,
          height: 1,
          backgroundColor: palette.contentBg,
        }}
      >
        {renderSpans(cell.spans, contentWidth, theme.text, `${keyPrefix}:content`)}
      </box>
    </box>
  );
}

function diffMessage(file: DiffFile) {
  if (file.metadata.type === "rename-pure") {
    return "No textual hunks. This change only renames the file.";
  }

  if (file.metadata.type === "new") {
    return "No textual hunks. The file is marked as new.";
  }

  if (file.metadata.type === "deleted") {
    return "No textual hunks. The file is marked as deleted.";
  }

  return "No textual hunks to render for this file.";
}

function findMaxLineNumber(file: DiffFile) {
  let highest = 0;

  for (const hunk of file.metadata.hunks) {
    highest = Math.max(highest, hunk.deletionStart + hunk.deletionCount, hunk.additionStart + hunk.additionCount);
  }

  return Math.max(highest, 1);
}

function renderHeaderRow(row: Extract<DiffRow, { type: "collapsed" | "hunk-header" }>, width: number, theme: AppTheme, selected: boolean) {
  const label =
    row.type === "collapsed"
      ? fitText(`··· ${row.text} ···`, Math.max(0, width - 1))
      : fitText(row.text, Math.max(0, width - 1));

  return (
    <box
      key={row.key}
      style={{
        width: "100%",
        height: 1,
        flexDirection: "row",
        backgroundColor: selected ? theme.selectedHunk : theme.panelAlt,
      }}
    >
      <box style={{ width: 1, height: 1 }}>
        <text fg={selected ? theme.accent : theme.panelAlt}>{marker(selected)}</text>
      </box>
      <box style={{ width: Math.max(0, width - 1), height: 1 }}>
        <text fg={row.type === "collapsed" ? theme.muted : theme.badgeNeutral}>{label}</text>
      </box>
    </box>
  );
}

function renderRow(row: DiffRow, layout: Exclude<LayoutMode, "auto">, width: number, lineNumberDigits: number, theme: AppTheme, selectedHunkIndex: number) {
  const selected = row.hunkIndex === selectedHunkIndex;

  if (row.type === "collapsed" || row.type === "hunk-header") {
    return renderHeaderRow(row, width, theme, selected);
  }

  if (layout === "split" && row.type === "split-line") {
    const markerWidth = 1;
    const separatorWidth = 1;
    const usableWidth = Math.max(0, width - markerWidth - separatorWidth);
    const leftWidth = Math.max(0, Math.floor(usableWidth / 2));
    const rightWidth = Math.max(0, usableWidth - leftWidth);

    return (
      <box key={row.key} style={{ width: "100%", height: 1, flexDirection: "row" }}>
        <box style={{ width: markerWidth, height: 1 }}>
          <text fg={selected ? theme.accent : theme.panel}>{marker(selected)}</text>
        </box>
        {renderSplitCell(row.left, leftWidth, lineNumberDigits, theme, selected, `${row.key}:left`)}
        <box
          style={{
            width: separatorWidth,
            height: 1,
            backgroundColor: theme.panel,
          }}
        >
          <text fg={theme.border}>│</text>
        </box>
        {renderSplitCell(row.right, rightWidth, lineNumberDigits, theme, selected, `${row.key}:right`)}
      </box>
    );
  }

  if (row.type === "stack-line") {
    return (
      <box key={row.key} style={{ width: "100%", height: 1, flexDirection: "row" }}>
        <box style={{ width: 1, height: 1 }}>
          <text fg={selected ? theme.accent : theme.panel}>{marker(selected)}</text>
        </box>
        {renderStackCell(row.cell, Math.max(0, width - 1), lineNumberDigits, theme, selected, `${row.key}:stack`)}
      </box>
    );
  }

  return (
    <box key={row.key} style={{ width: "100%", height: 1 }}>
      <text fg={theme.muted}>Unsupported row.</text>
    </box>
  );
}

export function PierreDiffView({
  file,
  layout,
  theme,
  width,
  selectedHunkIndex,
}: {
  file: DiffFile | undefined;
  layout: Exclude<LayoutMode, "auto">;
  theme: AppTheme;
  width: number;
  selectedHunkIndex: number;
}) {
  const [highlightedDiffs, setHighlightedDiffs] = useState<Record<string, HighlightedDiffCode | undefined>>({});

  useEffect(() => {
    if (!file || highlightedDiffs[file.id]) {
      return;
    }

    let cancelled = false;

    loadHighlightedDiff(file)
      .then((highlighted) => {
        if (cancelled) {
          return;
        }

        setHighlightedDiffs((current) => ({
          ...current,
          [file.id]: highlighted,
        }));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setHighlightedDiffs((current) => ({
          ...current,
          [file.id]: {
            deletionLines: [],
            additionLines: [],
          },
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [file, highlightedDiffs]);

  if (!file) {
    return (
      <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
        <text fg={theme.muted}>No file selected.</text>
      </box>
    );
  }

  if (file.metadata.hunks.length === 0) {
    return (
      <box style={{ flexGrow: 1, alignItems: "center", justifyContent: "center", padding: 1 }}>
        <text fg={theme.muted}>{diffMessage(file)}</text>
      </box>
    );
  }

  const highlighted = highlightedDiffs[file.id] ?? null;
  const rows = layout === "split" ? buildSplitRows(file, highlighted, theme) : buildStackRows(file, highlighted, theme);
  const lineNumberDigits = String(findMaxLineNumber(file)).length;

  return (
    <scrollbox width="100%" height="100%" scrollY={true} viewportCulling={true} focused={false}>
      <box style={{ width: "100%", flexDirection: "column" }}>
        {rows.map((row) => renderRow(row, layout, width, lineNumberDigits, theme, selectedHunkIndex))}
      </box>
    </scrollbox>
  );
}
