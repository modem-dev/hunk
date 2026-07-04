// Headless STML rendering for `hunk markup render`: markup in, terminal text
// out. Gives agents a preview loop — see what a note will look like at a
// given width before publishing it — without launching the TUI.

import type { AppTheme } from "../../themes";
import { resolveStmlColor } from "./colors";
import { layoutStml, type StmlLine, type StmlSpan } from "./layout";

export interface StmlTextRenderResult {
  /** One string per terminal row. */
  lines: string[];
  /** Parse/layout degradation notes, empty when the markup is clean. */
  errors: string[];
}

function lineToPlainText(line: StmlLine): string {
  return line.spans
    .map((span) => span.text)
    .join("")
    .replace(/\s+$/, "");
}

/** Render markup to plain text rows at a given width. */
export function renderStmlToText(markup: string, width: number): StmlTextRenderResult {
  const { lines, errors } = layoutStml(markup, width);
  return { lines: lines.map(lineToPlainText), errors };
}

function hexToRgb(color: string): [number, number, number] | null {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    return null;
  }
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** Build the SGR prefix for one styled span; empty when the span is plain. */
function spanSgr(span: StmlSpan, theme: AppTheme): string {
  const codes: string[] = [];
  if (span.bold) {
    codes.push("1");
  }
  if (span.dim) {
    codes.push("2");
  }
  if (span.italic) {
    codes.push("3");
  }
  if (span.underline) {
    codes.push("4");
  }
  if (span.strike) {
    codes.push("9");
  }
  const fg = resolveStmlColor(span.fg, theme);
  const fgRgb = fg ? hexToRgb(fg) : null;
  if (fgRgb) {
    codes.push(`38;2;${fgRgb[0]};${fgRgb[1]};${fgRgb[2]}`);
  }
  const bg = resolveStmlColor(span.bg, theme);
  const bgRgb = bg ? hexToRgb(bg) : null;
  if (bgRgb) {
    codes.push(`48;2;${bgRgb[0]};${bgRgb[1]};${bgRgb[2]}`);
  }
  return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

/** Render markup to ANSI-colored rows, resolving colors against a theme. */
export function renderStmlToAnsi(
  markup: string,
  width: number,
  theme: AppTheme,
): StmlTextRenderResult {
  const { lines, errors } = layoutStml(markup, width);
  const rendered = lines.map((line) => {
    const parts = line.spans.map((span) => {
      const sgr = spanSgr(span, theme);
      return sgr ? `${sgr}${span.text}\x1b[0m` : span.text;
    });
    return parts.join("").replace(/\s+$/, "");
  });
  return { lines: rendered, errors };
}
