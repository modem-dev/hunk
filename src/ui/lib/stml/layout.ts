// STML -> styled terminal lines. Turns a parsed STML tree into a flat list of
// fixed-width line/span rows.
//
// Hunk's review stream is row-windowed: every planned row must know its exact
// terminal height before it mounts (see plannedReviewRows.ts). A flexbox
// renderer cannot promise that, so this is a small deterministic layout
// engine instead — the same (markup, width) input always produces the same
// lines, and a note's height is simply `lines.length`.
//
// Colors stay symbolic here (`accent`, `success`, `#ff00aa`); resolving them
// against the active AppTheme happens at render time in resolveStmlColor, so
// measurement never needs a theme.

import { measureTextWidth, sliceTextByWidth } from "../text";
import { decodeStmlEntities, parseStml, type StmlElement, type StmlNode } from "./parse";

export interface StmlStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  strike?: boolean;
}

export interface StmlSpan extends StmlStyle {
  text: string;
}

export interface StmlLine {
  spans: StmlSpan[];
}

export interface StmlLayoutResult {
  lines: StmlLine[];
  errors: string[];
}

/** Minimum content width the layout engine will attempt to fill. */
export const MIN_STML_LAYOUT_WIDTH = 8;

/**
 * The width agents should design notes for when the live width is unknown,
 * and the default preview width. Chosen to match the tightest common note
 * body: a split layout dock on a typical terminal. Documented in the STML
 * guide. Write-path validation prefers the session's live note width.
 */
export const STML_REFERENCE_WIDTH = 56;

/** Lay out markup at one note width and return its render notes. */
export function validateStmlMarkup(markup: string, width: number = STML_REFERENCE_WIDTH): string[] {
  return layoutStmlCached(markup, width).errors;
}

const MAX_LAYOUT_ERRORS = 20;

const INLINE_TAGS = new Set([
  "b",
  "strong",
  "i",
  "em",
  "u",
  "dim",
  "muted",
  "s",
  "strike",
  "del",
  "c",
  "color",
  "span",
  "a",
  "link",
  "kbd",
  "badge",
  "br",
]);

interface BorderChars {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
}

const BORDER_STYLES: Record<string, BorderChars> = {
  single: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
  },
  rounded: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
  },
  double: {
    topLeft: "╔",
    topRight: "╗",
    bottomLeft: "╚",
    bottomRight: "╝",
    horizontal: "═",
    vertical: "║",
  },
  heavy: {
    topLeft: "┏",
    topRight: "┓",
    bottomLeft: "┗",
    bottomRight: "┛",
    horizontal: "━",
    vertical: "┃",
  },
};

const truthyAttr = (value: string | undefined) =>
  value === undefined || value === "" || value === "true" || value === "yes" || value === "on";

const collapseWs = (text: string) => text.replace(/\s+/g, " ");

const mergeStyle = (base: StmlStyle, over: StmlStyle): StmlStyle => ({ ...base, ...over });

function numAttr(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Resolve a width attribute (cells or percentage of the available width). */
function widthAttr(value: string | undefined, available: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (percent) {
    return Math.max(1, Math.floor((available * Number(percent[1])) / 100));
  }
  const n = numAttr(value);
  return n !== undefined ? Math.max(1, Math.floor(n)) : undefined;
}

function attrStyle(attrs: Record<string, string>): StmlStyle {
  const style: StmlStyle = {};
  if (attrs.fg ?? attrs.color) {
    style.fg = attrs.fg ?? attrs.color;
  }
  if (attrs.bg) {
    style.bg = attrs.bg;
  }
  if ("bold" in attrs) {
    style.bold = truthyAttr(attrs.bold);
  }
  if ("italic" in attrs) {
    style.italic = truthyAttr(attrs.italic);
  }
  if ("underline" in attrs) {
    style.underline = truthyAttr(attrs.underline);
  }
  if ("dim" in attrs) {
    style.dim = truthyAttr(attrs.dim);
  }
  if ("strike" in attrs) {
    style.strike = truthyAttr(attrs.strike);
  }
  return style;
}

function inlineStyle(tag: string, attrs: Record<string, string>): StmlStyle {
  switch (tag) {
    case "b":
    case "strong":
      return { bold: true };
    case "i":
    case "em":
      return { italic: true };
    case "u":
      return { underline: true };
    case "s":
    case "strike":
    case "del":
      return { strike: true };
    case "dim":
    case "muted":
      return { dim: true };
    case "kbd":
      return { bg: "subtle", fg: "heading" };
    case "badge":
      return {
        bg: attrs.color ?? attrs.bg ?? "accent",
        fg: attrs.fg ?? "badge-text",
        bold: true,
      };
    case "a":
    case "link":
      return { fg: "accent", underline: true };
    default:
      return attrStyle(attrs);
  }
}

class LayoutErrors {
  readonly messages: string[] = [];

  add(message: string) {
    if (this.messages.length < MAX_LAYOUT_ERRORS) {
      this.messages.push(message);
    } else if (this.messages.length === MAX_LAYOUT_ERRORS) {
      this.messages.push("further layout notes omitted");
    }
  }
}

// --- inline flow ---

/** Flatten one inline subtree into styled spans; `\n` spans mark hard breaks. */
function inlineSpans(node: StmlNode, style: StmlStyle): StmlSpan[] {
  if (node.type === "text") {
    const text = collapseWs(decodeStmlEntities(node.value));
    return text === "" ? [] : [{ ...style, text }];
  }
  if (node.tag === "br") {
    return [{ ...style, text: "\n" }];
  }
  const next = mergeStyle(style, inlineStyle(node.tag, node.attrs));
  const padded = node.tag === "badge" || node.tag === "kbd";
  const out: StmlSpan[] = [];
  if (padded) {
    out.push({ ...next, text: " " });
  }
  for (const child of node.children) {
    out.push(...inlineSpans(child, next));
  }
  if (padded) {
    out.push({ ...next, text: " " });
  }
  return out;
}

interface InlineToken {
  span: StmlSpan;
  kind: "word" | "space" | "break";
  width: number;
}

/** Split styled spans into wrap-safe word/space/break tokens. */
function tokenizeSpans(spans: StmlSpan[]): InlineToken[] {
  const tokens: InlineToken[] = [];
  for (const span of spans) {
    const parts = span.text.split(/(\n| +)/);
    for (const part of parts) {
      if (part === "") {
        continue;
      }
      if (part === "\n") {
        tokens.push({ span: { ...span, text: "\n" }, kind: "break", width: 0 });
      } else if (/^ +$/.test(part) && !span.bg) {
        // Background-colored spaces (badge/kbd padding) are visible content,
        // so only plain spaces participate in wrap collapsing.
        tokens.push({ span: { ...span, text: part }, kind: "space", width: part.length });
      } else {
        tokens.push({ span: { ...span, text: part }, kind: "word", width: measureTextWidth(part) });
      }
    }
  }
  return tokens;
}

function sameStyle(a: StmlStyle, b: StmlStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.dim === b.dim &&
    a.strike === b.strike
  );
}

/** Append a span to a line, merging with the previous span when styles match. */
function pushSpan(line: StmlLine, span: StmlSpan) {
  const last = line.spans[line.spans.length - 1];
  if (last && sameStyle(last, span)) {
    last.text += span.text;
  } else {
    line.spans.push({ ...span });
  }
}

/** Greedy word-wrap styled spans into lines no wider than `width`. */
function wrapSpans(spans: StmlSpan[], width: number): StmlLine[] {
  const usable = Math.max(1, width);
  const tokens = tokenizeSpans(spans);
  const lines: StmlLine[] = [];
  let current: StmlLine = { spans: [] };
  let currentWidth = 0;
  let started = false;

  const flush = () => {
    // Right-trim plain trailing spaces; bg-colored spaces stay (see tokenize).
    while (current.spans.length > 0) {
      const last = current.spans[current.spans.length - 1]!;
      if (last.bg || !/^ *$/.test(last.text)) {
        last.text = last.bg ? last.text : last.text.replace(/ +$/, "");
        break;
      }
      current.spans.pop();
    }
    lines.push(current);
    current = { spans: [] };
    currentWidth = 0;
    started = false;
  };

  for (const token of tokens) {
    if (token.kind === "break") {
      flush();
      continue;
    }
    if (token.kind === "space") {
      // Leading spaces on a fresh line vanish, matching normal text flow.
      if (!started) {
        continue;
      }
      if (currentWidth + token.width > usable) {
        flush();
        continue;
      }
      pushSpan(current, token.span);
      currentWidth += token.width;
      continue;
    }

    if (currentWidth + token.width <= usable) {
      pushSpan(current, token.span);
      currentWidth += token.width;
      started = true;
      continue;
    }

    if (started) {
      flush();
    }

    // A word longer than the whole line gets hard-sliced across lines.
    let rest = token.span.text;
    while (measureTextWidth(rest) > usable) {
      const slice = sliceTextByWidth(rest, 0, usable);
      if (slice.text.length === 0) {
        break;
      }
      pushSpan(current, { ...token.span, text: slice.text });
      flush();
      rest = rest.slice(slice.text.length);
    }
    if (rest.length > 0) {
      pushSpan(current, { ...token.span, text: rest });
      currentWidth = measureTextWidth(rest);
      started = true;
    }
  }

  // Trim trailing whitespace-only tail and drop a dangling empty line unless
  // it is the only line (an explicit <br> chain keeps its blank rows).
  if (current.spans.length > 0 || lines.length === 0) {
    lines.push(current);
  }
  return lines;
}

function lineWidth(line: StmlLine): number {
  return line.spans.reduce((total, span) => total + measureTextWidth(span.text), 0);
}

/** Pad every line to an exact width, filling with the block background. */
function padLines(lines: StmlLine[], width: number, bg?: string): StmlLine[] {
  return lines.map((line) => {
    const spans = bg
      ? line.spans.map((span) => ({ ...span, bg: span.bg ?? bg }))
      : line.spans.map((span) => ({ ...span }));
    const used = lineWidth({ spans });
    if (used < width) {
      spans.push({ text: " ".repeat(width - used), ...(bg ? { bg } : {}) });
    }
    return { spans };
  });
}

// --- raw text helpers (for <code>/<pre>) ---

const rawText = (el: StmlElement) =>
  el.children.map((child) => (child.type === "text" ? child.value : "")).join("");

// Strip the leading newline and shared indentation so agents can indent the
// body of a <code> block to match surrounding markup.
function dedent(text: string): string {
  const lines = text.replace(/^\n/, "").replace(/\s+$/, "").split("\n");
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    min = Math.min(min, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(min) || min === 0) {
    return lines.join("\n");
  }
  return lines.map((line) => line.slice(min)).join("\n");
}

// --- block layout ---

function borderChars(styleAttr: string | undefined, fallback: keyof typeof BORDER_STYLES) {
  if (styleAttr && BORDER_STYLES[styleAttr]) {
    return { chars: BORDER_STYLES[styleAttr]!, unknown: false };
  }
  return { chars: BORDER_STYLES[fallback]!, unknown: styleAttr !== undefined };
}

/** Wrap block content in a box frame with optional title and padding. */
function frameLines(
  content: StmlLine[],
  {
    width,
    border,
    chars,
    borderColor,
    title,
    titleColor,
    bg,
    paddingX,
    paddingY,
  }: {
    width: number;
    border: boolean;
    chars: BorderChars;
    borderColor: string;
    title?: string;
    titleColor: string;
    bg?: string;
    paddingX: number;
    paddingY: number;
  },
): StmlLine[] {
  const innerWidth = Math.max(1, width - (border ? 2 : 0) - paddingX * 2);
  const padded = padLines(content, innerWidth, bg);
  const sidePad: StmlSpan | null =
    paddingX > 0 ? { text: " ".repeat(paddingX), ...(bg ? { bg } : {}) } : null;

  const bodyLines: StmlLine[] = [];
  const blankRow = (): StmlLine => ({
    spans: [{ text: " ".repeat(innerWidth + paddingX * 2), ...(bg ? { bg } : {}) }],
  });

  for (let i = 0; i < paddingY; i++) {
    bodyLines.push(blankRow());
  }
  for (const line of padded) {
    const spans: StmlSpan[] = [];
    if (sidePad) {
      spans.push({ ...sidePad });
    }
    spans.push(...line.spans);
    if (sidePad) {
      spans.push({ ...sidePad });
    }
    bodyLines.push({ spans });
  }
  for (let i = 0; i < paddingY; i++) {
    bodyLines.push(blankRow());
  }

  if (!border) {
    return bodyLines;
  }

  const horizontalWidth = Math.max(0, width - 2);
  const top: StmlLine = { spans: [] };
  if (title && title.trim() !== "") {
    const label = ` ${title.trim()} `;
    const fitted = sliceTextByWidth(label, 0, Math.max(0, horizontalWidth - 2)).text;
    const remainder = Math.max(0, horizontalWidth - 1 - measureTextWidth(fitted));
    top.spans.push({ text: `${chars.topLeft}${chars.horizontal}`, fg: borderColor });
    top.spans.push({ text: fitted, fg: titleColor, bold: true });
    top.spans.push({
      text: `${chars.horizontal.repeat(remainder)}${chars.topRight}`,
      fg: borderColor,
    });
  } else {
    top.spans.push({
      text: `${chars.topLeft}${chars.horizontal.repeat(horizontalWidth)}${chars.topRight}`,
      fg: borderColor,
    });
  }

  const bottom: StmlLine = {
    spans: [
      {
        text: `${chars.bottomLeft}${chars.horizontal.repeat(horizontalWidth)}${chars.bottomRight}`,
        fg: borderColor,
      },
    ],
  };

  const framed: StmlLine[] = [top];
  for (const line of bodyLines) {
    framed.push({
      spans: [
        { text: chars.vertical, fg: borderColor, ...(bg ? { bg } : {}) },
        ...line.spans,
        { text: chars.vertical, fg: borderColor, ...(bg ? { bg } : {}) },
      ],
    });
  }
  framed.push(bottom);
  return framed;
}

/** Lay out one bullet/numbered item with a hanging indent. */
function bulletLines(
  prefix: string,
  children: StmlNode[],
  width: number,
  style: StmlStyle,
  errors: LayoutErrors,
): StmlLine[] {
  const prefixWidth = measureTextWidth(prefix);
  const bodyWidth = Math.max(1, width - prefixWidth);
  const body = layoutBlockNodes(children, bodyWidth, style, errors);
  return body.map((line, index) => ({
    spans: [
      index === 0 ? { text: prefix, fg: "muted" } : { text: " ".repeat(prefixWidth) },
      ...line.spans,
    ],
  }));
}

/** Merge column line lists side by side, padding shorter columns. */
function mergeColumns(columns: StmlLine[][], widths: number[], gap: number): StmlLine[] {
  const height = Math.max(0, ...columns.map((column) => column.length));
  const merged: StmlLine[] = [];
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const spans: StmlSpan[] = [];
    columns.forEach((column, columnIndex) => {
      if (columnIndex > 0 && gap > 0) {
        spans.push({ text: " ".repeat(gap) });
      }
      const width = widths[columnIndex]!;
      const line = column[rowIndex];
      if (line) {
        spans.push(...line.spans);
        const used = lineWidth(line);
        if (used < width) {
          spans.push({ text: " ".repeat(width - used) });
        }
      } else {
        spans.push({ text: " ".repeat(width) });
      }
    });
    merged.push({ spans });
  }
  return merged;
}

function layoutRow(
  el: StmlElement,
  width: number,
  style: StmlStyle,
  errors: LayoutErrors,
): StmlLine[] {
  const children = el.children.filter(
    (child): child is StmlElement => child.type === "element" && !INLINE_TAGS.has(child.tag),
  );
  const looseInline = el.children.filter(
    (child) => child.type === "text" || (child.type === "element" && INLINE_TAGS.has(child.tag)),
  );

  if (children.length === 0) {
    return layoutBlockNodes(el.children, width, style, errors);
  }
  if (looseInline.some((node) => node.type !== "text" || node.value.trim() !== "")) {
    errors.add("<row> mixes bare text with block children; text laid out above the row");
  }

  const gap = Math.max(0, numAttr(el.attrs.gap) ?? 1);
  const totalGap = gap * (children.length - 1);
  const available = width - totalGap;

  // Fixed-width columns claim their space first; the rest share what remains.
  const fixed = children.map((child) => widthAttr(child.attrs.width, available));
  const fixedTotal = fixed.reduce<number>((total, w) => total + (w ?? 0), 0);
  const flexCount = fixed.filter((w) => w === undefined).length;
  const flexSpace = Math.max(flexCount, available - fixedTotal);
  const flexWidth = flexCount > 0 ? Math.floor(flexSpace / flexCount) : 0;
  let flexRemainder = flexCount > 0 ? flexSpace - flexWidth * flexCount : 0;

  if (available < children.length) {
    // Too narrow to sit side by side — degrade to stacked blocks.
    errors.add("<row> too narrow for its columns; stacking vertically");
    return children.flatMap((child) => layoutBlock(child, width, style, errors));
  }

  const widths = fixed.map((w) => {
    if (w !== undefined) {
      return Math.max(1, Math.min(w, available));
    }
    const extra = flexRemainder > 0 ? 1 : 0;
    flexRemainder -= extra;
    return Math.max(1, flexWidth + extra);
  });

  const inlinePrefix =
    looseInline.length > 0 ? layoutBlockNodes(looseInline, width, style, errors) : [];
  const columns = children.map((child, index) => layoutBlock(child, widths[index]!, style, errors));
  return [...inlinePrefix, ...mergeColumns(columns, widths, gap)];
}

function layoutBlock(
  el: StmlElement,
  width: number,
  style: StmlStyle,
  errors: LayoutErrors,
): StmlLine[] {
  const tag = el.tag;
  switch (tag) {
    case "box":
    case "card":
    case "col":
    case "column":
    case "stack":
    case "section": {
      const isCard = tag === "card";
      const border =
        "border" in el.attrs ? truthyAttr(el.attrs.border) : isCard || "border-style" in el.attrs;
      const { chars, unknown } = borderChars(
        el.attrs["border-style"],
        isCard ? "rounded" : "single",
      );
      if (unknown) {
        errors.add(`unknown border-style "${el.attrs["border-style"]}"`);
      }
      const padding = Math.max(0, numAttr(el.attrs.padding) ?? (isCard ? 1 : 0));
      const paddingX = Math.max(0, numAttr(el.attrs["padding-x"]) ?? padding);
      const paddingY = Math.max(0, numAttr(el.attrs["padding-y"]) ?? padding);
      const requestedWidth = widthAttr(el.attrs.width, width);
      const boxWidth = Math.max(4, Math.min(requestedWidth ?? width, width));
      const innerWidth = Math.max(1, boxWidth - (border ? 2 : 0) - paddingX * 2);
      const childStyle = mergeStyle(style, attrStyle(el.attrs));
      const content = layoutBlockNodes(el.children, innerWidth, childStyle, errors);
      return frameLines(content, {
        width: boxWidth,
        border,
        chars,
        borderColor: el.attrs["border-color"] ?? "note-border",
        title: el.attrs.title,
        titleColor: el.attrs["title-color"] ?? "heading",
        bg: el.attrs.bg,
        paddingX,
        paddingY,
      });
    }

    case "row":
      return layoutRow(el, width, style, errors);

    case "text":
    case "p":
      return wrapSpans(
        el.children.flatMap((child) => inlineSpans(child, mergeStyle(style, attrStyle(el.attrs)))),
        width,
      );

    case "h":
    case "h1":
    case "h2":
    case "h3":
    case "heading":
    case "title": {
      const base = mergeStyle(style, {
        bold: true,
        fg: el.attrs.fg ?? el.attrs.color ?? "heading",
      });
      if (tag === "h1" || tag === "title") {
        base.underline = true;
      }
      return wrapSpans(
        el.children.flatMap((child) => inlineSpans(child, base)),
        width,
      );
    }

    case "hr":
    case "rule":
    case "divider":
      return [
        {
          spans: [{ text: "─".repeat(Math.max(1, width)), fg: el.attrs.color ?? "muted" }],
        },
      ];

    case "spacer":
    case "space": {
      const size = Math.max(1, Math.min(20, numAttr(el.attrs.size) ?? 1));
      return Array.from({ length: size }, () => ({ spans: [{ text: "" }] }));
    }

    case "list":
    case "ul":
    case "ol": {
      const ordered = tag === "ol";
      const marker = el.attrs.marker ?? "•";
      const lines: StmlLine[] = [];
      let index = 1;
      for (const child of el.children) {
        if (child.type !== "element" || (child.tag !== "item" && child.tag !== "li")) {
          continue;
        }
        const prefix = ordered ? `${index++}. ` : `${marker} `;
        lines.push(...bulletLines(prefix, child.children, width, style, errors));
      }
      return lines;
    }

    case "item":
    case "li":
      return bulletLines("• ", el.children, width, style, errors);

    case "code":
    case "pre": {
      const { chars } = borderChars(el.attrs["border-style"], "single");
      const codeStyle: StmlStyle = { ...style, fg: el.attrs.fg ?? style.fg };
      const codeWidth = Math.max(1, width - 4);
      const content = dedent(rawText(el))
        .split("\n")
        .map((line): StmlLine => {
          // Code never soft-wraps; long lines clip so the block height stays
          // proportional to its source line count.
          const fitted = sliceTextByWidth(line.replaceAll("\t", "  "), 0, codeWidth);
          return { spans: [{ ...codeStyle, text: fitted.text }] };
        });
      return frameLines(content, {
        width,
        border: true,
        chars,
        borderColor: el.attrs["border-color"] ?? "subtle",
        title: el.attrs.title,
        titleColor: "heading",
        bg: el.attrs.bg,
        paddingX: 1,
        paddingY: 0,
      });
    }

    default: {
      errors.add(`unknown tag <${tag}>`);
      return layoutBlockNodes(el.children, width, style, errors);
    }
  }
}

/** Walk a child list: group consecutive inline nodes, lay out blocks one by one. */
function layoutBlockNodes(
  nodes: StmlNode[],
  width: number,
  style: StmlStyle,
  errors: LayoutErrors,
): StmlLine[] {
  const out: StmlLine[] = [];
  let run: StmlNode[] = [];

  const flush = () => {
    if (run.length === 0) {
      return;
    }
    const spans = run.flatMap((node) => inlineSpans(node, style));
    const meaningful = spans.some((span) => span.text.trim() !== "" || span.text === "\n");
    if (meaningful) {
      out.push(...wrapSpans(spans, width));
    }
    run = [];
  };

  for (const node of nodes) {
    if (node.type === "text" || INLINE_TAGS.has(node.tag)) {
      run.push(node);
      continue;
    }
    flush();
    out.push(...layoutBlock(node, width, style, errors));
  }
  flush();
  return out;
}

/** Parse STML markup and lay it out into styled lines for a given width. */
export function layoutStml(markup: string, width: number): StmlLayoutResult {
  if (width < MIN_STML_LAYOUT_WIDTH) {
    return { lines: [], errors: [`width ${width} below minimum ${MIN_STML_LAYOUT_WIDTH}`] };
  }

  const errors = new LayoutErrors();
  const parsed = parseStml(markup);
  for (const message of parsed.errors) {
    errors.add(message);
  }

  const lines = layoutBlockNodes(parsed.nodes, width, {}, errors);

  // Drop leading/trailing fully blank rows so the note card hugs its content.
  while (
    lines.length > 0 &&
    lineWidth(lines[0]!) === 0 &&
    lines[0]!.spans.every((s) => s.text.trim() === "")
  ) {
    lines.shift();
  }
  while (
    lines.length > 0 &&
    lineWidth(lines[lines.length - 1]!) === 0 &&
    lines[lines.length - 1]!.spans.every((s) => s.text.trim() === "")
  ) {
    lines.pop();
  }

  return { lines, errors: errors.messages };
}

// Layout is recomputed by both measurement (plannedReviewRows) and rendering
// (AgentInlineNote) on every plan pass, so memoize per (markup, width).
const layoutCache = new Map<string, StmlLayoutResult>();
const LAYOUT_CACHE_LIMIT = 256;

/** Memoized layoutStml for the hot measure/render path. */
export function layoutStmlCached(markup: string, width: number): StmlLayoutResult {
  const key = `${width} ${markup}`;
  const cached = layoutCache.get(key);
  if (cached) {
    return cached;
  }
  const result = layoutStml(markup, width);
  if (layoutCache.size >= LAYOUT_CACHE_LIMIT) {
    // Simple full reset: the cache only exists to dedupe the measure/render
    // pair within a frame, not to persist history.
    layoutCache.clear();
  }
  layoutCache.set(key, result);
  return result;
}
