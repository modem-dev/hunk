/**
 * Parses Markdown into a small, inert document tree for the rendered Markdown preview.
 *
 * Deliberately a subset, and deliberately incapable of producing HTML: headings, paragraphs,
 * emphasis, strong, strikethrough, inline code, fenced and indented code blocks, ordered and
 * unordered lists (nested by indentation), block quotes, links, horizontal rules, and simple
 * pipe tables. Everything else — raw HTML included — stays text, because the tree has no node
 * that carries markup and the renderer (`./MarkdownView.tsx`) builds React elements from it.
 *
 * Links keep their target only when it parses as an absolute `http:` or `https:` URL; any
 * other target (`javascript:`, `data:`, relative paths) renders as its text. Images render as
 * their alt text: the page loads no remote images.
 *
 * Bounded work on hostile input: an unterminated fence runs to the end of the document,
 * nesting is capped, and lines longer than `MAX_INLINE_LINE_LENGTH` are kept as plain text
 * instead of being scanned for emphasis delimiters.
 */

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "emphasis" | "strong" | "strike"; children: MarkdownInline[] }
  | { type: "link"; href: string; children: MarkdownInline[] }
  | { type: "break" };

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInline[] }
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "code"; language?: string; text: string }
  | { type: "quote"; children: MarkdownBlock[] }
  | { type: "list"; ordered: boolean; start?: number; items: MarkdownBlock[][] }
  | { type: "rule" }
  | {
      type: "table";
      align: Array<"left" | "center" | "right" | undefined>;
      header: MarkdownInline[][];
      rows: MarkdownInline[][][];
    };

/** Lines longer than this are not scanned for inline markup; they render as text. */
export const MAX_INLINE_LINE_LENGTH = 10_000;

/** Deepest block or inline nesting the parser follows before treating the rest as text. */
export const MAX_MARKDOWN_NESTING = 12;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^( {0,3})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})[.)]\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const INLINE_STARTERS = new Set(["\\", "`", "!", "[", "<", "*", "_", "~"]);

/** Whether one link target is an absolute web URL the preview may link to. */
export function safeMarkdownHref(target: string): string | undefined {
  try {
    const url = new URL(target.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Split one table row into its cells, honoring escaped pipes. */
function tableCells(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (character === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** Parse one run of inline text. */
export function parseMarkdownInline(text: string, depth = 0): MarkdownInline[] {
  if (depth >= MAX_MARKDOWN_NESTING || text.length > MAX_INLINE_LINE_LENGTH) {
    return text ? [{ type: "text", text }] : [];
  }
  const nodes: MarkdownInline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) nodes.push({ type: "text", text: buffer });
    buffer = "";
  };

  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    // Only these characters can start inline markup; everything else is copied as text.
    if (!INLINE_STARTERS.has(character)) {
      buffer += character;
      index += 1;
      continue;
    }
    const rest = text.slice(index);

    if (character === "\\" && index + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[index + 1]!)) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

    if (character === "`") {
      const fence = /^`+/.exec(rest)![0];
      const close = text.indexOf(fence, index + fence.length);
      if (close >= 0) {
        flush();
        nodes.push({ type: "code", text: text.slice(index + fence.length, close).trim() || " " });
        index = close + fence.length;
        continue;
      }
      buffer += fence;
      index += fence.length;
      continue;
    }

    // `![alt](src)`: images are shown as their alt text.
    const image = /^!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/.exec(rest);
    if (image) {
      buffer += image[1];
      index += image[0].length;
      continue;
    }

    // Targets may hold one level of balanced parentheses, as URLs often do.
    const link = /^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush();
      const children = parseMarkdownInline(link[1]!, depth + 1);
      const href = safeMarkdownHref(link[2]!);
      if (href) nodes.push({ type: "link", href, children });
      else nodes.push(...children);
      index += link[0].length;
      continue;
    }

    const autolink = /^<(https?:\/\/[^\s<>]+)>/.exec(rest);
    if (autolink) {
      const href = safeMarkdownHref(autolink[1]!);
      if (href) {
        flush();
        nodes.push({ type: "link", href, children: [{ type: "text", text: autolink[1]! }] });
        index += autolink[0].length;
        continue;
      }
    }

    const delimiter = /^(\*\*|__|~~|\*|_)/.exec(rest)?.[1];
    if (delimiter) {
      const close = text.indexOf(delimiter, index + delimiter.length);
      const inner = close >= 0 ? text.slice(index + delimiter.length, close) : "";
      // Intraword underscores (snake_case) are text, as in CommonMark.
      const intraword =
        delimiter[0] === "_" &&
        /\w/.test(text[index - 1] ?? "") &&
        /\w/.test(text[close + delimiter.length] ?? "");
      if (close >= 0 && inner.trim() && inner === inner.trim() && !intraword) {
        flush();
        nodes.push({
          type: delimiter === "~~" ? "strike" : delimiter.length === 2 ? "strong" : "emphasis",
          children: parseMarkdownInline(inner, depth + 1),
        });
        index = close + delimiter.length;
        continue;
      }
      buffer += delimiter;
      index += delimiter.length;
      continue;
    }

    buffer += character;
    index += 1;
  }
  flush();
  return nodes;
}

/** Remove up to `width` columns of leading indentation. */
function dedent(line: string, width: number) {
  let removed = 0;
  let index = 0;
  while (index < line.length && removed < width && line[index] === " ") {
    index += 1;
    removed += 1;
  }
  return line.slice(index);
}

/** Parse one Markdown document, or one container's content, into blocks. */
export function parseMarkdown(source: string, depth = 0): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (depth >= MAX_MARKDOWN_NESTING) {
    return [{ type: "paragraph", children: [{ type: "text", text: lines.join("\n") }] }];
  }
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  const isBlockStart = (line: string) =>
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line);

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const closing = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}\\s*$`);
      const body: string[] = [];
      index += 1;
      // An unterminated fence runs to the end of the document.
      while (index < lines.length && !closing.test(lines[index]!)) {
        body.push(lines[index]!);
        index += 1;
      }
      index += 1;
      blocks.push({
        type: "code",
        ...(fence[2] ? { language: fence[2] } : {}),
        text: body.join("\n"),
      });
      continue;
    }

    if (/^ {4}|^\t/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && (/^ {4}|^\t/.test(lines[index]!) || !lines[index]!.trim())) {
        body.push(lines[index]!.replace(/^( {4}|\t)/, ""));
        index += 1;
      }
      while (body.length > 0 && !body.at(-1)!.trim()) body.pop();
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseMarkdownInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        body.push(QUOTE.exec(lines[index]!)![1]!);
        index += 1;
      }
      blocks.push({ type: "quote", children: parseMarkdown(body.join("\n"), depth + 1) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = !bullet;
      const pattern = isOrdered ? ORDERED : BULLET;
      const items: MarkdownBlock[][] = [];
      const start = ordered ? Number(ordered[2]) : undefined;
      while (index < lines.length) {
        const item = pattern.exec(lines[index]!);
        if (!item) break;
        const indent = item[1]!.length + item[2]!.length + 1;
        const body = [item[3]!];
        index += 1;
        // Continuation: indented lines, and blank lines followed by indented ones.
        while (index < lines.length) {
          const next = lines[index]!;
          if (next.trim() && /^\s{2,}/.test(next)) {
            body.push(dedent(next, indent));
            index += 1;
          } else if (!next.trim() && /^\s{2,}\S/.test(lines[index + 1] ?? "")) {
            body.push("");
            index += 1;
          } else {
            break;
          }
        }
        items.push(parseMarkdown(body.join("\n"), depth + 1));
      }
      blocks.push({
        type: "list",
        ordered: isOrdered,
        ...(isOrdered && start !== undefined && start !== 1 ? { start } : {}),
        items,
      });
      continue;
    }

    if (line.includes("|") && TABLE_DIVIDER.test(lines[index + 1] ?? "")) {
      const header = tableCells(line);
      const align = tableCells(lines[index + 1]!).map((cell) =>
        cell.startsWith(":") && cell.endsWith(":")
          ? ("center" as const)
          : cell.endsWith(":")
            ? ("right" as const)
            : cell.startsWith(":")
              ? ("left" as const)
              : undefined,
      );
      index += 2;
      const rows: MarkdownInline[][][] = [];
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) {
        const cells = tableCells(lines[index]!);
        rows.push(header.map((_cell, column) => parseMarkdownInline(cells[column] ?? "")));
        index += 1;
      }
      blocks.push({
        type: "table",
        align,
        header: header.map((cell) => parseMarkdownInline(cell)),
        rows,
      });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      (paragraph.length === 0 || !isBlockStart(lines[index]!))
    ) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    const children: MarkdownInline[] = [];
    paragraph.forEach((text, position) => {
      if (position > 0) children.push({ type: "text", text: " " });
      children.push(...parseMarkdownInline(text));
    });
    blocks.push({ type: "paragraph", children });
  }
  return blocks;
}
