/**
 * Non-interactive `hunk pager` renderer for captured pager hosts.
 *
 * Hunk's normal pager integration is a full-screen interactive TUI: Git pipes patch text on stdin,
 * and Hunk opens the controlling terminal for keyboard/mouse input. That works for `core.pager`,
 * but tools such as LazyGit invoke custom pagers inside their own diff panel and advertise a
 * constrained environment (notably `TERM=dumb`). Launching the TUI there either hangs, corrupts the
 * host panel with alternate-screen control sequences, or leaves no usable diff output.
 *
 * This module is the fallback output adapter for those contexts. It intentionally reuses Hunk's
 * normal parse/highlight/render planning stack (`loadAppBootstrap`, Pierre metadata,
 * `loadHighlightedDiff`, and Pierre row builders) and only serializes the resulting rows to ANSI
 * text. Keep it as a thin adapter: do not introduce a second diff parser or a parallel review model
 * here. If the static renderer cannot parse or render safely, callers fall back to the original patch
 * text so pager pipelines keep working.
 */
import { loadAppBootstrap } from "../core/loaders";
import type { CommonOptions, CustomThemeConfig, DiffFile } from "../core/types";
import {
  buildSplitRows,
  buildStackRows,
  loadHighlightedDiff,
  type DiffRow,
  type RenderSpan,
  type SplitLineCell,
} from "./diff/pierre";
import { resolveSplitPaneWidths, resolveSplitCellGeometry } from "./diff/codeColumns";
import {
  diffRailMarker,
  neutralRailColor,
  splitCellPalette,
  splitGutterText,
  splitLeftRailColor,
  splitRightRailColor,
  stackCellPalette,
  stackGutterText,
  stackRailColor,
} from "./diff/rowStyle";
import { sliceTextByWidth } from "./lib/text";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../lib/terminalText";
import { resolveTheme, withTransparentSurfaces, type AppTheme } from "./themes";

const DEFAULT_STATIC_WIDTH = 120;
const MIN_STATIC_WIDTH = 20;
const RESET = "\x1b[0m";

/** Convert a six-digit hex color into one ANSI truecolor code. */
function ansiColor(kind: "fg" | "bg", hex: string | undefined) {
  const normalized = hex?.replace(/^#/, "");
  if (!normalized || !/^[0-9a-f]{6}$/i.test(normalized)) {
    return "";
  }

  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `\x1b[${kind === "fg" ? 38 : 48};2;${red};${green};${blue}m`;
}

/** Wrap one terminal text fragment in ANSI colors. */
function colorText(text: string, fg?: string, bg?: string) {
  const safeText = sanitizeTerminalLine(text);
  if (!safeText) {
    return "";
  }

  const prefix = `${ansiColor("fg", fg)}${ansiColor("bg", bg)}`;
  return prefix ? `${prefix}${safeText}${RESET}` : safeText;
}

/** Serialize highlighted code spans into ANSI text, preserving a row background when present. */
function serializeSpans(spans: RenderSpan[], rowBg: string) {
  return spans.map((span) => colorText(span.text, span.fg, span.bg ?? rowBg)).join("");
}

/** Serialize spans into one fixed-width pane so split rows keep both sides aligned. */
function serializeSpansFixedWidth(spans: RenderSpan[], rowBg: string, width: number) {
  let remaining = Math.max(0, width);
  let usedWidth = 0;
  let output = "";

  for (const span of spans) {
    if (remaining <= 0) {
      break;
    }

    const visible = sliceTextByWidth(span.text, 0, remaining);
    if (visible.text) {
      output += colorText(visible.text, span.fg, span.bg ?? rowBg);
      usedWidth += visible.width;
      remaining -= visible.width;
    }
  }

  if (usedWidth < width) {
    output += colorText(" ".repeat(width - usedWidth), undefined, rowBg);
  }

  return output;
}

const marker = diffRailMarker;

function renderHeaderLikeRow(text: string, fg: string, bg: string, theme: AppTheme) {
  return `${colorText(marker(), neutralRailColor(theme), bg)}${colorText(text.trimEnd(), fg, bg)}`;
}

function fixedWidthText(text: string, width: number) {
  const visible = sliceTextByWidth(text, 0, width);
  return `${visible.text}${" ".repeat(Math.max(0, width - visible.width))}`;
}

function staticStackGutterText(
  cell: Extract<DiffRow, { type: "stack-line" }>["cell"],
  lineNumberWidth: number,
  showLineNumbers: boolean,
) {
  return stackGutterText(cell, lineNumberWidth, showLineNumbers).padEnd(
    showLineNumbers ? lineNumberWidth * 2 + 5 : 2,
  );
}

function staticSplitGutterText(
  cell: SplitLineCell,
  lineNumberWidth: number,
  showLineNumbers: boolean,
) {
  return splitGutterText(cell, lineNumberWidth, showLineNumbers).padEnd(
    showLineNumbers ? lineNumberWidth + 3 : 2,
  );
}

/** Render one non-interactive stacked diff row as ANSI text. */
function renderStaticStackRow(
  row: DiffRow,
  theme: AppTheme,
  lineNumberWidth: number,
  options: CommonOptions,
) {
  if (row.type === "collapsed") {
    return renderHeaderLikeRow(`··· ${row.text} ···`, theme.muted, theme.panelAlt, theme);
  }

  if (row.type === "hunk-header") {
    return options.hunkHeaders === false
      ? ""
      : renderHeaderLikeRow(row.text, theme.badgeNeutral, theme.panelAlt, theme);
  }

  if (row.type !== "stack-line") {
    return "";
  }

  const { cell } = row;
  const palette = stackCellPalette(cell.kind, theme, cell.moveKind);
  return `${colorText(marker(), stackRailColor(cell.kind, theme, true), theme.panel)}${colorText(
    staticStackGutterText(cell, lineNumberWidth, options.lineNumbers !== false),
    palette.numberColor,
    palette.gutterBg,
  )}${serializeSpans(cell.spans, palette.contentBg)}`;
}

function renderStaticSplitCell(
  cell: SplitLineCell,
  side: "left" | "right",
  width: number,
  theme: AppTheme,
  lineNumberWidth: number,
  options: CommonOptions,
) {
  const palette = splitCellPalette(cell.kind, theme, cell.moveKind);
  const { gutterWidth, contentWidth } = resolveSplitCellGeometry(
    width,
    lineNumberWidth,
    options.lineNumbers !== false,
    marker().length,
  );
  const railColor =
    side === "left"
      ? splitLeftRailColor(cell.kind, theme, true)
      : splitRightRailColor(cell.kind, theme, true);
  const gutterText = fixedWidthText(
    staticSplitGutterText(cell, lineNumberWidth, options.lineNumbers !== false),
    gutterWidth,
  );

  return `${colorText(marker(), railColor, theme.panel)}${colorText(
    gutterText,
    palette.numberColor,
    palette.gutterBg,
  )}${serializeSpansFixedWidth(cell.spans, palette.contentBg, contentWidth)}`;
}

/** Render one non-interactive split diff row as ANSI text. */
function renderStaticSplitRow(
  row: DiffRow,
  theme: AppTheme,
  lineNumberWidth: number,
  options: CommonOptions,
  width: number,
) {
  if (row.type === "collapsed") {
    return renderHeaderLikeRow(`··· ${row.text} ···`, theme.muted, theme.panelAlt, theme);
  }

  if (row.type === "hunk-header") {
    return options.hunkHeaders === false
      ? ""
      : renderHeaderLikeRow(row.text, theme.badgeNeutral, theme.panelAlt, theme);
  }

  if (row.type !== "split-line") {
    return "";
  }

  const { leftWidth, rightWidth } = resolveSplitPaneWidths(width);
  return `${renderStaticSplitCell(
    row.left,
    "left",
    leftWidth,
    theme,
    lineNumberWidth,
    options,
  )}${renderStaticSplitCell(row.right, "right", rightWidth, theme, lineNumberWidth, options)}`;
}

function maxLineNumberWidth(file: DiffFile, rows: DiffRow[]) {
  let max = 1;
  for (const row of rows) {
    if (row.type === "stack-line") {
      max = Math.max(
        max,
        row.cell.oldLineNumber ? String(row.cell.oldLineNumber).length : 1,
        row.cell.newLineNumber ? String(row.cell.newLineNumber).length : 1,
      );
      continue;
    }

    if (row.type === "split-line") {
      max = Math.max(
        max,
        row.left.lineNumber ? String(row.left.lineNumber).length : 1,
        row.right.lineNumber ? String(row.right.lineNumber).length : 1,
      );
    }
  }

  return Math.max(max, String(file.metadata.additionLines.length).length);
}

/** Describe the file-level change without exposing raw patch transport headers. */
function fileStatusLabel(file: DiffFile) {
  if (file.isTooLarge) {
    return "skipped large file";
  }

  if (file.isBinary) {
    return "binary";
  }

  switch (file.metadata.type) {
    case "new":
      return file.isUntracked ? "untracked" : "new file";
    case "deleted":
      return "deleted";
    case "rename-pure":
      return "renamed";
    case "rename-changed":
      return "renamed modified";
    case "change":
    default:
      return file.metadata.prevMode && file.metadata.prevMode !== file.metadata.mode
        ? "mode changed"
        : "modified";
  }
}

/** Use an arrow label for renamed files so static output keeps important path metadata. */
function fileDisplayPath(file: DiffFile) {
  const previousPath = file.previousPath ?? file.metadata.prevName;
  return previousPath && previousPath !== file.path
    ? `${sanitizeTerminalLine(previousPath)} → ${sanitizeTerminalLine(file.path)}`
    : sanitizeTerminalLine(file.path);
}

function fileModeText(file: DiffFile) {
  if (
    file.metadata.prevMode &&
    file.metadata.mode &&
    file.metadata.prevMode !== file.metadata.mode
  ) {
    return ` ${file.metadata.prevMode}→${file.metadata.mode}`;
  }

  if ((file.metadata.type === "new" || file.metadata.type === "deleted") && file.metadata.mode) {
    return ` ${file.metadata.mode}`;
  }

  return "";
}

function resolveStaticLayout(options: CommonOptions) {
  // Static pager output has historically defaulted to stack rows even on wide terminals.
  // Honor only an explicit split request here so captured hosts avoid surprise layout changes.
  return options.mode === "split" ? "split" : "stack";
}

/** Format one parsed diff file for static pager hosts like LazyGit's diff panel. */
async function renderStaticFile(
  file: DiffFile,
  theme: AppTheme,
  options: CommonOptions,
  width: number,
) {
  const highlighted =
    file.isBinary || file.isTooLarge ? null : await loadHighlightedDiff(file, theme.appearance);
  const layout = resolveStaticLayout(options);
  const rows =
    layout === "split"
      ? buildSplitRows(file, highlighted, theme)
      : buildStackRows(file, highlighted, theme);
  const lineNumberWidth = maxLineNumberWidth(file, rows);
  const stats = `${colorText(`+${file.stats.additions}${file.statsTruncated ? "+" : ""}`, theme.badgeAdded)} ${colorText(`-${file.stats.deletions}`, theme.badgeRemoved)}`;
  const status = colorText(`${fileStatusLabel(file)}${fileModeText(file)}`, theme.muted);
  const header = `${colorText(fileDisplayPath(file), theme.text)} ${status} ${stats}`;

  if (rows.length === 0) {
    const message = file.isTooLarge
      ? "  Skipped because the file is too large to render."
      : file.isBinary
        ? "  Binary file."
        : "  No textual changes.";
    return [header, colorText(message, theme.muted)].join("\n");
  }

  return [
    header,
    ...rows
      .map((row) =>
        layout === "split"
          ? renderStaticSplitRow(row, theme, lineNumberWidth, options, width)
          : renderStaticStackRow(row, theme, lineNumberWidth, options),
      )
      .filter(Boolean),
  ].join("\n");
}

function fallbackMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error || "unknown error");
}

export interface StaticDiffPagerDeps {
  customTheme?: CustomThemeConfig;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  terminalColumns?: number;
}

function resolveStaticWidth(deps: StaticDiffPagerDeps) {
  return Math.max(
    MIN_STATIC_WIDTH,
    Math.floor(deps.terminalColumns ?? process.stdout.columns ?? DEFAULT_STATIC_WIDTH),
  );
}

function warnFallback(deps: StaticDiffPagerDeps, reason: string) {
  deps.stderr?.write(
    `hunk: static pager render failed; falling back to raw diff (${sanitizeTerminalLine(reason)}).\n`,
  );
}

/** Render diff-like pager stdin as colored static output, falling back to the original patch on failure. */
export async function renderStaticDiffPager(
  text: string,
  options: CommonOptions = {},
  deps: StaticDiffPagerDeps = { stderr: process.stderr },
) {
  try {
    const bootstrap = await loadAppBootstrap({
      kind: "patch",
      file: "-",
      text,
      options: {
        ...options,
        pager: true,
      },
    });
    const resolvedTheme = resolveTheme(options.theme, null, deps.customTheme);
    const theme = options.transparentBackground
      ? withTransparentSurfaces(resolvedTheme)
      : resolvedTheme;
    const width = resolveStaticWidth(deps);
    const rendered = await Promise.all(
      bootstrap.changeset.files.map((file) => renderStaticFile(file, theme, options, width)),
    );

    if (rendered.length === 0) {
      warnFallback(deps, "no files rendered");
      return sanitizeTerminalText(text);
    }

    return `${rendered.join("\n\n")}\n`;
  } catch (error) {
    warnFallback(deps, fallbackMessage(error));
    return sanitizeTerminalText(text);
  }
}
