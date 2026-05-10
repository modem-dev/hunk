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
 * `loadHighlightedDiff`, and `buildStackRows`) and only serializes the resulting stack rows to ANSI
 * text. Keep it as a thin adapter: do not introduce a second diff parser or a parallel review model
 * here. If the static renderer cannot parse or render safely, callers fall back to the original patch
 * text so pager pipelines keep working.
 */
import { loadAppBootstrap } from "../core/loaders";
import type { CommonOptions, DiffFile } from "../core/types";
import { buildStackRows, loadHighlightedDiff, type DiffRow, type RenderSpan } from "./diff/pierre";
import {
  diffRailMarker,
  neutralRailColor,
  stackCellPalette,
  stackGutterText,
  stackRailColor,
} from "./diff/rowStyle";
import { resolveTheme, type AppTheme } from "./themes";

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
  if (!text) {
    return "";
  }

  const prefix = `${ansiColor("fg", fg)}${ansiColor("bg", bg)}`;
  return prefix ? `${prefix}${text}${RESET}` : text;
}

/** Serialize highlighted code spans into ANSI text, preserving a row background when present. */
function serializeSpans(spans: RenderSpan[], rowBg: string) {
  return spans.map((span) => colorText(span.text, span.fg, span.bg ?? rowBg)).join("");
}

const marker = diffRailMarker;

function renderHeaderLikeRow(text: string, fg: string, bg: string, theme: AppTheme) {
  return `${colorText(marker(), neutralRailColor(theme), bg)}${colorText(text.trimEnd(), fg, bg)}`;
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

/** Render one non-interactive stacked diff row as ANSI text. */
function renderStaticRow(
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
  const palette = stackCellPalette(cell.kind, theme);
  return `${colorText(marker(), stackRailColor(cell.kind, theme, true), theme.panel)}${colorText(
    staticStackGutterText(cell, lineNumberWidth, options.lineNumbers !== false),
    palette.numberColor,
    palette.gutterBg,
  )}${serializeSpans(cell.spans, palette.contentBg)}`;
}

function maxLineNumberWidth(file: DiffFile, rows: DiffRow[]) {
  let max = 1;
  for (const row of rows) {
    if (row.type !== "stack-line") {
      continue;
    }

    max = Math.max(
      max,
      row.cell.oldLineNumber ? String(row.cell.oldLineNumber).length : 1,
      row.cell.newLineNumber ? String(row.cell.newLineNumber).length : 1,
    );
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
  return previousPath && previousPath !== file.path ? `${previousPath} → ${file.path}` : file.path;
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

/** Format one parsed diff file for static pager hosts like LazyGit's diff panel. */
async function renderStaticFile(file: DiffFile, theme: AppTheme, options: CommonOptions) {
  const highlighted =
    file.isBinary || file.isTooLarge ? null : await loadHighlightedDiff(file, theme.appearance);
  const rows = buildStackRows(file, highlighted, theme);
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
    ...rows.map((row) => renderStaticRow(row, theme, lineNumberWidth, options)).filter(Boolean),
  ].join("\n");
}

function fallbackMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error || "unknown error");
}

export interface StaticDiffPagerDeps {
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

function warnFallback(deps: StaticDiffPagerDeps, reason: string) {
  deps.stderr?.write(`hunk: static pager render failed; falling back to raw diff (${reason}).\n`);
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
    const theme = resolveTheme(options.theme, null);
    const rendered = await Promise.all(
      bootstrap.changeset.files.map((file) => renderStaticFile(file, theme, options)),
    );

    if (rendered.length === 0) {
      warnFallback(deps, "no files rendered");
      return text;
    }

    return `${rendered.join("\n\n")}\n`;
  } catch (error) {
    warnFallback(deps, fallbackMessage(error));
    return text;
  }
}
