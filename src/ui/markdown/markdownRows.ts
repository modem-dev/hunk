import { marked, type Token, type Tokens } from "marked";
import { measureTextWidth, wrapText } from "../lib/text";

export type MarkdownSpanKind = "text" | "strong" | "em" | "code" | "link";
export interface MarkdownSpan {
  text: string;
  kind: MarkdownSpanKind;
  href?: string;
}
export type MarkdownRowKind =
  | "heading"
  | "paragraph"
  | "bullet"
  | "ordered"
  | "quote"
  | "rule"
  | "code"
  | "blank";
export interface MarkdownRow {
  kind: MarkdownRowKind;
  level?: number;
  ordinal?: number;
  spans: MarkdownSpan[];
  language?: string;
}

/** Flatten marked inline tokens into styled spans, recursing through emphasis/links. */
function flattenInline(
  tokens: Token[] | undefined,
  kind: MarkdownSpanKind = "text",
): MarkdownSpan[] {
  if (!tokens) {
    return [];
  }
  const spans: MarkdownSpan[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        spans.push(...flattenInline((token as Tokens.Strong).tokens, "strong"));
        break;
      case "em":
        spans.push(...flattenInline((token as Tokens.Em).tokens, "em"));
        break;
      case "codespan":
        spans.push({ text: (token as Tokens.Codespan).text, kind: "code" });
        break;
      case "link": {
        const link = token as Tokens.Link;
        const inner = flattenInline(link.tokens, "link");
        const text = inner.map((s) => s.text).join("") || link.href;
        spans.push({ text, kind: "link", href: link.href });
        break;
      }
      case "br":
        spans.push({ text: " ", kind });
        break;
      default: {
        const text = (token as Tokens.Text).text ?? "";
        if (text) {
          spans.push({ text, kind });
        }
      }
    }
  }
  return spans;
}

/**
 * Word-wrap a list of styled spans to a width, preserving each word's span kind
 * (strong/em/code/link) across line breaks. Whitespace between words is collapsed
 * to a single space and never starts a line; words longer than the width are
 * hard-broken. Returns one entry per visual line; always at least one line.
 */
export function wrapStyledSpans(spans: MarkdownSpan[], width: number): MarkdownSpan[][] {
  const max = Math.max(1, width);
  const lines: MarkdownSpan[][] = [];
  let line: MarkdownSpan[] = [];
  let lineWidth = 0;

  /** Push the current line (trimming a trailing space) and start a fresh one. */
  const flush = () => {
    const last = line.at(-1);
    if (last) {
      last.text = last.text.replace(/\s+$/, "");
      if (last.text.length === 0) {
        line.pop();
      }
    }
    lines.push(line.length ? line : [{ text: "", kind: "text" }]);
    line = [];
    lineWidth = 0;
  };

  /** Append text to the current line, merging into the previous span when styling matches. */
  const append = (text: string, span: MarkdownSpan) => {
    const prev = line.at(-1);
    if (prev && prev.kind === span.kind && prev.href === span.href) {
      prev.text += text;
    } else {
      line.push(span.href ? { text, kind: span.kind, href: span.href } : { text, kind: span.kind });
    }
    lineWidth += measureTextWidth(text);
  };

  for (const span of spans) {
    // Split into words while keeping the whitespace runs as their own parts.
    for (const part of span.text.split(/(\s+)/)) {
      if (!part) {
        continue;
      }
      if (/^\s+$/.test(part)) {
        // Collapse runs of whitespace to a single space; never start a line with one.
        if (lineWidth > 0 && lineWidth < max) {
          append(" ", span);
        }
        continue;
      }
      let word = part;
      // Hard-break words that cannot fit on a line by themselves.
      while (measureTextWidth(word) > max) {
        if (lineWidth > 0) {
          flush();
        }
        append(word.slice(0, max), span);
        word = word.slice(max);
        flush();
      }
      if (lineWidth > 0 && lineWidth + measureTextWidth(word) > max) {
        flush();
      }
      append(word, span);
    }
  }
  flush();
  return lines;
}

/** Render block-level tokens into rows, tracking list nesting depth. */
function renderTokens(tokens: Token[], width: number, depth: number): MarkdownRow[] {
  const rows: MarkdownRow[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        rows.push({ kind: "heading", level: heading.depth, spans: flattenInline(heading.tokens) });
        rows.push({ kind: "blank", spans: [] });
        break;
      }
      case "paragraph": {
        // Emit one logical row with the full styled spans; the renderer wraps
        // to the available width (where the prefix/indent width is known).
        const para = token as Tokens.Paragraph;
        rows.push({ kind: "paragraph", spans: flattenInline(para.tokens) });
        rows.push({ kind: "blank", spans: [] });
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        list.items.forEach((item, index) => {
          const itemSpans = flattenInline(
            item.tokens?.[0]?.type === "text" ? (item.tokens[0] as Tokens.Text).tokens : undefined,
          );
          rows.push({
            kind: list.ordered ? "ordered" : "bullet",
            level: depth,
            ordinal: list.ordered ? Number(list.start || 1) + index : undefined,
            spans: itemSpans.length ? itemSpans : [{ text: item.text, kind: "text" }],
          });
          // Recurse into nested block tokens (e.g. nested lists) at depth + 1.
          const nested = (item.tokens ?? []).filter((t) => t.type === "list");
          rows.push(...renderTokens(nested, width, depth + 1));
        });
        rows.push({ kind: "blank", spans: [] });
        break;
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        for (const inner of renderTokens(quote.tokens, Math.max(1, width - 2), depth)) {
          rows.push(inner.kind === "blank" ? inner : { ...inner, kind: "quote" });
        }
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        for (const line of code.text.split("\n")) {
          rows.push({
            kind: "code",
            language: code.lang || undefined,
            spans: [{ text: line, kind: "text" }],
          });
        }
        rows.push({ kind: "blank", spans: [] });
        break;
      }
      case "hr":
        rows.push({ kind: "rule", spans: [] });
        break;
      case "space":
        rows.push({ kind: "blank", spans: [] });
        break;
      default: {
        // Unsupported token (table, html, image, etc.): degrade to readable text.
        const raw =
          (token as { text?: string; raw?: string }).text ?? (token as { raw?: string }).raw ?? "";
        for (const line of wrapText(raw.trim(), Math.max(1, width))) {
          if (line) {
            rows.push({ kind: "paragraph", spans: [{ text: line, kind: "text" }] });
          }
        }
      }
    }
  }
  return rows;
}

/** Parse markdown into themeable rows. Tolerant: never throws on malformed input. */
export function renderMarkdownRows(markdown: string, width: number): MarkdownRow[] {
  let tokens: Token[];
  try {
    tokens = marked.lexer(markdown ?? "");
  } catch {
    return wrapText((markdown ?? "").trim(), Math.max(1, width)).map((line) => ({
      kind: "paragraph" as const,
      spans: [{ text: line, kind: "text" as const }],
    }));
  }
  const rows = renderTokens(tokens, width, 0);
  // Trim a trailing blank row for tidy modal sizing.
  if (rows.at(-1)?.kind === "blank") {
    rows.pop();
  }
  return rows;
}
