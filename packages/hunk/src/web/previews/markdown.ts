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
 * The source is attacker-authored repository content parsed on the page's main thread, so work
 * is linear in the input and output is bounded:
 *
 * - Block and inline syntax is recognized by hand-written forward scans, not regular
 *   expressions, so no line can trigger backtracking. Each line is classified a bounded number
 *   of times per nesting level, and nesting stops at `MAX_MARKDOWN_NESTING`.
 * - Inline lookahead (closing delimiters, `]`, link targets, code-span closers) is answered
 *   from caches or tables built once per line, so repeated unmatched openers never rescan.
 * - Lines longer than `MAX_BLOCK_LINE_LENGTH` skip block detection and render as paragraph
 *   text; lines longer than `MAX_INLINE_LINE_LENGTH` are not scanned for inline markup.
 * - Tables keep at most `MAX_TABLE_COLUMNS` columns and never pad short rows, and a document
 *   stops at `MAX_MARKDOWN_NODES` nodes with a visible `truncated` block instead of silent loss.
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
      /** Body rows, each with at most as many cells as the header; short rows are not padded. */
      rows: MarkdownInline[][][];
      /** Set when some row had more than `MAX_TABLE_COLUMNS` cells and the rest were dropped. */
      clipped?: true;
    }
  /** The node budget ran out here; the rest of the document is not rendered. */
  | { type: "truncated" };

/** Lines longer than this are not scanned for inline markup; they render as text. */
export const MAX_INLINE_LINE_LENGTH = 10_000;

/** Lines longer than this skip block detection and render as paragraph text. */
export const MAX_BLOCK_LINE_LENGTH = 10_000;

/** Deepest block or inline nesting the parser follows before treating the rest as text. */
export const MAX_MARKDOWN_NESTING = 12;

/** Most columns one table keeps; cells past this are dropped and the table is marked clipped. */
export const MAX_TABLE_COLUMNS = 64;

/** Most blocks, inline nodes, list items, and table cells one document produces. */
export const MAX_MARKDOWN_NODES = 50_000;

/** Largest source the rendered view accepts; larger documents show their diff instead. */
export const MAX_MARKDOWN_PREVIEW_BYTES = 512 * 1024;

/** Work and output counters shared by one parse. */
interface ParseState {
  /** Nodes emitted so far, against `MAX_MARKDOWN_NODES`. */
  nodes: number;
  /** Characters examined by the parser's scans, for tests that assert linear work. */
  steps: number;
  truncated: boolean;
}

/** The result of one parse, with the work it took. */
export interface MarkdownParseResult {
  blocks: MarkdownBlock[];
  /** Characters the scans examined; stays within a small multiple of the source length. */
  steps: number;
  nodes: number;
  truncated: boolean;
}

/** A fresh counter set for one parse. */
function createParseState(): ParseState {
  return { nodes: 0, steps: 0, truncated: false };
}

/** Count `count` emitted nodes; returns false once the budget is spent. */
function spend(state: ParseState, count = 1) {
  if (state.truncated) return false;
  if (state.nodes + count > MAX_MARKDOWN_NODES) {
    state.truncated = true;
    return false;
  }
  state.nodes += count;
  return true;
}

/** Whether one character is Markdown whitespace within a line. */
function isSpace(character: string | undefined) {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r" ||
    character === "\f" ||
    character === "\v"
  );
}

/** Whether one character is an ASCII letter, digit, or underscore. */
function isWordCharacter(character: string | undefined) {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

/** Whether one character is ASCII punctuation, which a backslash may escape. */
function isAsciiPunctuation(character: string | undefined) {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  );
}

/** Whether one line holds only whitespace. */
function isBlank(line: string) {
  for (let index = 0; index < line.length; index += 1) {
    if (!isSpace(line[index])) return false;
  }
  return true;
}

/** The index of the first non-whitespace character at or after `from`. */
function skipSpaces(line: string, from: number) {
  let index = from;
  while (index < line.length && isSpace(line[index])) index += 1;
  return index;
}

/** The index just past the last non-whitespace character before `end`. */
function trimEnd(line: string, end = line.length) {
  let index = end;
  while (index > 0 && isSpace(line[index - 1])) index -= 1;
  return index;
}

/** The block-start indentation (0–3 spaces), or -1 when the line is indented further. */
function blockIndent(line: string) {
  let index = 0;
  while (index < 4 && line[index] === " ") index += 1;
  return index === 4 ? -1 : index;
}

/** The length of the run of `character` starting at `from`. */
function runLength(line: string, from: number, character: string) {
  let index = from;
  while (line[index] === character) index += 1;
  return index - from;
}

/** Whether one link target is an absolute web URL the preview may link to. */
export function safeMarkdownHref(target: string): string | undefined {
  try {
    const url = new URL(target.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Split source text into lines on `\n`, `\r\n`, or `\r`. */
function splitLines(source: string, state: ParseState) {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\n" || character === "\r") {
      lines.push(source.slice(start, index));
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      start = index + 1;
    }
  }
  lines.push(source.slice(start));
  state.steps += source.length + 1;
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Block recognizers. Each is one forward scan of its line with no backtracking.
// ---------------------------------------------------------------------------------------------

/** An opening code fence: its marker run and info-string language. */
function openingFence(line: string) {
  const indent = blockIndent(line);
  if (indent < 0) return undefined;
  const character = line[indent];
  if (character !== "`" && character !== "~") return undefined;
  const length = runLength(line, indent, character);
  if (length < 3) return undefined;

  const infoStart = skipSpaces(line, indent + length);
  let infoEnd = infoStart;
  while (infoEnd < line.length && !isSpace(line[infoEnd]) && line[infoEnd] !== "`") infoEnd += 1;

  // A backtick fence's info string may not contain backticks, or it would be inline code.
  if (character === "`" && line.indexOf("`", indent + length) >= 0) return undefined;
  return { character, length, language: line.slice(infoStart, infoEnd) };
}

/** Whether `line` closes a fence opened with `length` copies of `character`. */
function isClosingFence(line: string, character: string, length: number) {
  const indent = blockIndent(line);
  if (indent < 0) return false;
  const run = runLength(line, indent, character);
  return run >= length && skipSpaces(line, indent + run) === line.length;
}

/** An ATX heading: its level and content with the closing `#` sequence removed. */
function atxHeading(line: string) {
  const indent = blockIndent(line);
  if (indent < 0) return undefined;
  const level = runLength(line, indent, "#");
  if (level < 1 || level > 6) return undefined;
  const afterMarker = indent + level;
  if (afterMarker < line.length && !isSpace(line[afterMarker])) return undefined;

  const start = skipSpaces(line, afterMarker);
  let end = trimEnd(line);
  if (end <= start) return { level: level as 1 | 2 | 3 | 4 | 5 | 6, text: "" };

  // A closing run of `#` counts only when whitespace precedes it (or it is the whole content).
  let hashes = end;
  while (hashes > start && line[hashes - 1] === "#") hashes -= 1;
  if (hashes === start) end = start;
  else if (hashes < end && isSpace(line[hashes - 1])) end = trimEnd(line, hashes);
  return { level: level as 1 | 2 | 3 | 4 | 5 | 6, text: line.slice(start, end) };
}

/** Whether `line` is a thematic break: three or more of one of `-*_`, spaces allowed. */
function isRule(line: string) {
  const indent = blockIndent(line);
  if (indent < 0) return false;
  const character = line[indent];
  if (character !== "-" && character !== "*" && character !== "_") return false;
  let count = 0;
  for (let index = indent; index < line.length; index += 1) {
    if (line[index] === character) count += 1;
    else if (!isSpace(line[index])) return false;
  }
  return count >= 3;
}

/** A block quote line's content after `>` and one optional space. */
function quoteContent(line: string) {
  const indent = blockIndent(line);
  if (indent < 0 || line[indent] !== ">") return undefined;
  const start = line[indent + 1] === " " ? indent + 2 : indent + 1;
  return line.slice(start);
}

/** One list item marker: its kind, the continuation indent, its content, and its number. */
interface ListMarker {
  ordered: boolean;
  /** Columns a continuation line is dedented by: indent, marker, and one space. */
  indent: number;
  content: string;
  start?: number;
}

/** A list item marker (`-`, `*`, `+`, or 1–9 digits then `.` or `)`) followed by whitespace. */
function listMarker(line: string): ListMarker | undefined {
  const indent = blockIndent(line);
  if (indent < 0) return undefined;
  const character = line[indent];
  let markerEnd: number;
  let start: number | undefined;
  if (character === "-" || character === "*" || character === "+") {
    markerEnd = indent + 1;
  } else {
    let digits = indent;
    while (digits < line.length && line[digits]! >= "0" && line[digits]! <= "9") digits += 1;
    const count = digits - indent;
    if (count < 1 || count > 9 || (line[digits] !== "." && line[digits] !== ")")) return undefined;
    start = Number(line.slice(indent, digits));
    markerEnd = digits + 1;
  }
  if (!isSpace(line[markerEnd])) return undefined;
  return {
    ordered: start !== undefined,
    indent: markerEnd + 1,
    content: line.slice(skipSpaces(line, markerEnd)),
    ...(start !== undefined ? { start } : {}),
  };
}

/** Whether `line` is indented code: four spaces or a tab. */
function isIndentedCode(line: string) {
  return line.startsWith("    ") || line[0] === "\t";
}

/** Remove one level of code indentation: four spaces or a tab. */
function stripCodeIndent(line: string) {
  if (line.startsWith("    ")) return line.slice(4);
  return line[0] === "\t" ? line.slice(1) : line;
}

/** Whether a continuation line is indented by at least two whitespace characters. */
function isIndentedContinuation(line: string) {
  return isSpace(line[0]) && isSpace(line[1]) && skipSpaces(line, 2) < line.length;
}

/** Remove up to `width` columns of leading spaces. */
function dedent(line: string, width: number) {
  let index = 0;
  while (index < line.length && index < width && line[index] === " ") index += 1;
  return line.slice(index);
}

/**
 * Split one table row into at most `limit` trimmed cells, honoring escaped pipes; `clipped`
 * reports cells past the limit.
 */
function tableCells(line: string, limit: number) {
  let start = skipSpaces(line, 0);
  let end = trimEnd(line);
  if (line[start] === "|") start += 1;
  if (end > start && line[end - 1] === "|" && line[end - 2] !== "\\") end -= 1;

  const cells: string[] = [];
  let current = "";
  let segment = start;
  for (let index = start; index < end; index += 1) {
    const character = line[index];
    if (character === "\\" && line[index + 1] === "|") {
      current += line.slice(segment, index) + "|";
      index += 1;
      segment = index + 1;
    } else if (character === "|") {
      if (cells.length === limit) return { cells, clipped: true };
      cells.push((current + line.slice(segment, index)).trim());
      current = "";
      segment = index + 1;
    }
  }
  if (cells.length === limit) return { cells, clipped: true };
  cells.push((current + line.slice(segment, end)).trim());
  return { cells, clipped: false };
}

/** Whether `line` is a table delimiter row: cells of `:?-+:?` separated by pipes. */
function isTableDivider(line: string) {
  let start = skipSpaces(line, 0);
  let end = trimEnd(line);
  if (line[start] === "|") start += 1;
  if (end > start && line[end - 1] === "|") end -= 1;
  if (end <= start) return false;

  // Each cell: optional spaces, optional `:`, one or more `-`, optional `:`, optional spaces.
  let index = start;
  while (true) {
    index = skipSpaces(line, index);
    if (line[index] === ":") index += 1;
    const dashes = runLength(line, index, "-");
    if (dashes === 0) return false;
    index += dashes;
    if (line[index] === ":") index += 1;
    index = skipSpaces(line, index);
    if (index === end) return true;
    if (index > end || line[index] !== "|") return false;
    index += 1;
  }
}

/** The column alignment one delimiter cell declares. */
function cellAlign(cell: string) {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center" as const;
  if (right) return "right" as const;
  return left ? ("left" as const) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Inline parsing.
// ---------------------------------------------------------------------------------------------

const INLINE_STARTERS = new Set(["\\", "`", "!", "[", "<", "*", "_", "~"]);

/**
 * Finds the next occurrence of one needle at or after a position that only moves forward,
 * remembering the last answer so unmatched openers never rescan the same text.
 */
class ForwardFinder {
  private from = -1;
  private found = -1;

  constructor(
    private readonly text: string,
    private readonly needle: string,
    private readonly state: ParseState,
  ) {}

  /** The first occurrence at or after `from`, or -1. */
  next(from: number) {
    // The cached answer is still the first occurrence when the query has not passed it.
    if (this.from >= 0 && from >= this.from && (this.found < 0 || this.found >= from)) {
      return this.found;
    }
    this.from = from;
    this.found = this.text.indexOf(this.needle, from);
    this.state.steps += (this.found < 0 ? this.text.length : this.found) - from + 1;
    return this.found;
  }
}

/**
 * Per-position lookup tables for link syntax, built right to left in one pass the first time a
 * line contains `[`: where a link target starting at `i` ends, the next non-space, the next
 * `"`, and the next `]`. They turn every link attempt into constant-time lookups.
 */
interface LinkTables {
  targetEnd: Int32Array;
  nextNonSpace: Int32Array;
  nextQuote: Int32Array;
  nextCloseBracket: Int32Array;
}

/** Build the link lookup tables for one line. */
function buildLinkTables(text: string, state: ParseState): LinkTables {
  const length = text.length;
  const targetEnd = new Int32Array(length + 1);
  const nextNonSpace = new Int32Array(length + 1);
  const nextQuote = new Int32Array(length + 1);
  const nextCloseBracket = new Int32Array(length + 1);
  // The next `(`, `)`, or whitespace, where a parenthesized target group stops.
  const nextStop = new Int32Array(length + 1);
  targetEnd[length] = nextNonSpace[length] = nextQuote[length] = length;
  nextCloseBracket[length] = nextStop[length] = length;

  for (let index = length - 1; index >= 0; index -= 1) {
    const character = text[index];
    const space = isSpace(character);
    nextNonSpace[index] = space ? nextNonSpace[index + 1]! : index;
    nextQuote[index] = character === '"' ? index : nextQuote[index + 1]!;
    nextCloseBracket[index] = character === "]" ? index : nextCloseBracket[index + 1]!;
    nextStop[index] =
      space || character === "(" || character === ")" ? index : nextStop[index + 1]!;

    // A target is a run of non-space, non-paren characters and balanced `(…)` groups whose
    // contents hold neither; it ends at whitespace, `)`, or an unbalanced `(`.
    if (space || character === ")") {
      targetEnd[index] = index;
    } else if (character === "(") {
      const stop = nextStop[index + 1]!;
      targetEnd[index] = stop < length && text[stop] === ")" ? targetEnd[stop + 1]! : index;
    } else {
      targetEnd[index] = targetEnd[index + 1]!;
    }
  }
  state.steps += length + 1;
  return { targetEnd, nextNonSpace, nextQuote, nextCloseBracket };
}

/**
 * The link destination opened by `(` at `open - 1`: `target` then optional whitespace and a
 * `"title"`, then `)`. Returns the target and the index just past `)`, or nothing.
 */
function linkDestination(text: string, open: number, tables: LinkTables) {
  const end = tables.targetEnd[open]!;
  if (text[end] === ")") return { target: text.slice(open, end), next: end + 1 };
  if (!isSpace(text[end])) return undefined;
  const title = tables.nextNonSpace[end]!;
  if (text[title] !== '"') return undefined;
  const closeQuote = tables.nextQuote[title + 1]!;
  if (closeQuote >= text.length || text[closeQuote + 1] !== ")") return undefined;
  return { target: text.slice(open, end), next: closeQuote + 2 };
}

/**
 * Exact-length backtick runs in one line, for code-span closers: a span opened by a run of
 * length `n` closes at the next maximal run of exactly `n` backticks.
 */
class BacktickRuns {
  private readonly runs = new Map<number, number[]>();
  private readonly cursors = new Map<number, number>();

  constructor(text: string, state: ParseState) {
    let index = 0;
    while (index < text.length) {
      if (text[index] !== "`") {
        index += 1;
        continue;
      }
      const length = runLength(text, index, "`");
      const list = this.runs.get(length);
      if (list) list.push(index);
      else this.runs.set(length, [index]);
      index += length;
    }
    state.steps += text.length + 1;
  }

  /** The start of the first run of exactly `length` backticks at or after `from`, or -1. */
  next(length: number, from: number) {
    const list = this.runs.get(length);
    if (!list) return -1;
    let cursor = this.cursors.get(length) ?? 0;
    while (cursor < list.length && list[cursor]! < from) cursor += 1;
    this.cursors.set(length, cursor);
    return cursor < list.length ? list[cursor]! : -1;
  }
}

/** Parse one run of inline text. */
export function parseMarkdownInline(text: string, depth = 0): MarkdownInline[] {
  return parseInline(text, depth, createParseState());
}

/** Parse one run of inline text against a shared parse budget. */
function parseInline(text: string, depth: number, state: ParseState): MarkdownInline[] {
  if (depth >= MAX_MARKDOWN_NESTING || text.length > MAX_INLINE_LINE_LENGTH) {
    state.steps += 1;
    return text && spend(state) ? [{ type: "text", text }] : [];
  }

  const nodes: MarkdownInline[] = [];
  let buffer = "";
  let tables: LinkTables | undefined;
  let backticks: BacktickRuns | undefined;
  const finders = new Map<string, ForwardFinder>();
  const finder = (needle: string) => {
    let found = finders.get(needle);
    if (!found) finders.set(needle, (found = new ForwardFinder(text, needle, state)));
    return found;
  };

  /** Emit one node, or stop once the budget is spent. */
  const emit = (node: MarkdownInline) => {
    if (!spend(state)) return false;
    nodes.push(node);
    return true;
  };

  /** Emit the pending literal text. */
  const flush = () => {
    const ok = !buffer || emit({ type: "text", text: buffer });
    buffer = "";
    return ok;
  };

  let index = 0;
  while (index < text.length && !state.truncated) {
    state.steps += 1;
    const character = text[index]!;

    // Only these characters can start inline markup; copy each run of others as text.
    if (!INLINE_STARTERS.has(character)) {
      let end = index + 1;
      while (end < text.length && !INLINE_STARTERS.has(text[end]!)) end += 1;
      state.steps += end - index;
      buffer += text.slice(index, end);
      index = end;
      continue;
    }

    if (character === "\\" && isAsciiPunctuation(text[index + 1])) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

    if (character === "`") {
      const length = runLength(text, index, "`");
      backticks ??= new BacktickRuns(text, state);
      const close = backticks.next(length, index + length);
      if (close >= 0) {
        if (!flush()) break;
        if (!emit({ type: "code", text: text.slice(index + length, close).trim() || " " })) break;
        index = close + length;
        continue;
      }
      buffer += text.slice(index, index + length);
      index += length;
      continue;
    }

    // `![alt](src)`: images are shown as their alt text.
    if (character === "!" && text[index + 1] === "[") {
      tables ??= buildLinkTables(text, state);
      const close = tables.nextCloseBracket[index + 2]!;
      const destination =
        text[close + 1] === "(" ? linkDestination(text, close + 2, tables) : undefined;
      if (destination) {
        buffer += text.slice(index + 2, close);
        index = destination.next;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    // `[text](target)`: targets may hold one level of balanced parentheses, as URLs often do.
    if (character === "[") {
      tables ??= buildLinkTables(text, state);
      const close = tables.nextCloseBracket[index + 1]!;
      const destination =
        close > index + 1 && text[close + 1] === "("
          ? linkDestination(text, close + 2, tables)
          : undefined;
      if (destination) {
        if (!flush()) break;
        const children = parseInline(text.slice(index + 1, close), depth + 1, state);
        const href = safeMarkdownHref(destination.target);
        if (href) {
          if (!emit({ type: "link", href, children })) break;
        } else {
          nodes.push(...children);
        }
        index = destination.next;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    // `<https://…>`: the scan stops at the next `<`, so repeated openers never overlap.
    if (character === "<") {
      const schemeEnd = text.startsWith("http://", index + 1)
        ? index + 8
        : text.startsWith("https://", index + 1)
          ? index + 9
          : -1;
      if (schemeEnd > 0) {
        let end = schemeEnd;
        while (end < text.length && !isSpace(text[end]) && text[end] !== "<" && text[end] !== ">") {
          end += 1;
        }
        state.steps += end - index;
        const href =
          end > schemeEnd && text[end] === ">"
            ? safeMarkdownHref(text.slice(index + 1, end))
            : undefined;
        if (href) {
          if (!flush()) break;
          if (
            !emit({
              type: "link",
              href,
              children: [{ type: "text", text: text.slice(index + 1, end) }],
            })
          )
            break;
          index = end + 1;
          continue;
        }
      }
      buffer += character;
      index += 1;
      continue;
    }

    // Emphasis delimiters are `*`, `_`, and `~~` only; every other inline starter that got this
    // far (`!` without `[`, a `\` before a non-punctuation character) is literal text.
    const emphasis = character === "*" || character === "_" || character === "~";
    const double = text[index + 1] === character;
    const delimiter = !emphasis
      ? ""
      : double
        ? character + character
        : character === "~"
          ? ""
          : character;
    if (delimiter) {
      const start = index + delimiter.length;
      const close = finder(delimiter).next(start);
      // Intraword underscores (snake_case) are text, as in CommonMark.
      const intraword =
        character === "_" &&
        isWordCharacter(text[index - 1]) &&
        isWordCharacter(text[close + delimiter.length]);
      if (close > start && !isSpace(text[start]) && !isSpace(text[close - 1]) && !intraword) {
        if (!flush()) break;
        const children = parseInline(text.slice(start, close), depth + 1, state);
        const type = delimiter === "~~" ? "strike" : delimiter.length === 2 ? "strong" : "emphasis";
        if (!emit({ type, children })) break;
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

  if (state.truncated) {
    // The budget ran out mid-line: keep what remains as one literal run, past the budget by one.
    buffer += text.slice(index);
    if (buffer) nodes.push({ type: "text", text: buffer });
    return nodes;
  }
  flush();
  return nodes;
}

// ---------------------------------------------------------------------------------------------
// Block parsing.
// ---------------------------------------------------------------------------------------------

/** Whether a line is too long for block detection and renders as paragraph text. */
function isLongLine(line: string) {
  return line.length > MAX_BLOCK_LINE_LENGTH;
}

/** Whether a line starts a block that interrupts a paragraph. */
function isBlockStart(line: string, state: ParseState) {
  if (isLongLine(line)) return false;
  state.steps += line.length + 1;
  return (
    openingFence(line) !== undefined ||
    atxHeading(line) !== undefined ||
    isRule(line) ||
    quoteContent(line) !== undefined ||
    listMarker(line) !== undefined
  );
}

/** Parse one Markdown document, or one container's content, into blocks. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  return parseMarkdownWithStats(source).blocks;
}

/** Parse one Markdown document and report the work it took and whether it was truncated. */
export function parseMarkdownWithStats(source: string): MarkdownParseResult {
  const state = createParseState();
  const blocks = parseBlocks(splitLines(source, state), 0, state);
  if (state.truncated) blocks.push({ type: "truncated" });
  return { blocks, steps: state.steps, nodes: state.nodes, truncated: state.truncated };
}

/** Parse a container's lines into blocks at one nesting depth. */
function parseBlocks(lines: readonly string[], depth: number, state: ParseState): MarkdownBlock[] {
  if (depth >= MAX_MARKDOWN_NESTING) {
    if (!spend(state, 2)) return [];
    const text = lines.join("\n");
    state.steps += text.length + 1;
    return [{ type: "paragraph", children: [{ type: "text", text }] }];
  }

  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length && !state.truncated) {
    const line = lines[index]!;
    state.steps += 1;
    if (isBlank(line)) {
      state.steps += line.length;
      index += 1;
      continue;
    }
    if (!spend(state)) break;

    if (isLongLine(line)) {
      blocks.push({ type: "paragraph", children: parseInline(line, depth, state) });
      index += 1;
      continue;
    }
    state.steps += line.length + 1;

    const fence = openingFence(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      // An unterminated fence runs to the end of the container.
      while (index < lines.length) {
        const next = lines[index]!;
        state.steps += 1;
        if (!isLongLine(next)) {
          state.steps += next.length;
          if (isClosingFence(next, fence.character, fence.length)) break;
        }
        body.push(next);
        index += 1;
      }
      index += 1;
      const text = body.join("\n");
      state.steps += text.length;
      blocks.push({ type: "code", ...(fence.language ? { language: fence.language } : {}), text });
      continue;
    }

    if (isIndentedCode(line)) {
      const body: string[] = [];
      while (index < lines.length && !isLongLine(lines[index]!)) {
        const next = lines[index]!;
        state.steps += next.length + 1;
        if (!isIndentedCode(next) && !isBlank(next)) break;
        body.push(stripCodeIndent(next));
        index += 1;
      }
      while (body.length > 0 && isBlank(body.at(-1)!)) body.pop();
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const heading = atxHeading(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading.level,
        children: parseInline(heading.text, depth, state),
      });
      index += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (quoteContent(line) !== undefined) {
      const body: string[] = [];
      while (index < lines.length && !isLongLine(lines[index]!)) {
        state.steps += lines[index]!.length + 1;
        const content = quoteContent(lines[index]!);
        if (content === undefined) break;
        body.push(content);
        index += 1;
      }
      blocks.push({ type: "quote", children: parseBlocks(body, depth + 1, state) });
      continue;
    }

    const first = listMarker(line);
    if (first) {
      const items: MarkdownBlock[][] = [];
      while (index < lines.length && !state.truncated && !isLongLine(lines[index]!)) {
        state.steps += lines[index]!.length + 1;
        const item = listMarker(lines[index]!);
        if (!item || item.ordered !== first.ordered || !spend(state)) break;
        const body = [item.content];
        index += 1;

        // Continuation: indented lines, and blank lines followed by indented ones.
        while (index < lines.length && !isLongLine(lines[index]!)) {
          const next = lines[index]!;
          state.steps += next.length + 1;
          if (!isBlank(next) && isIndentedContinuation(next)) {
            body.push(dedent(next, item.indent));
            index += 1;
          } else if (isBlank(next) && isIndentedContinuation(lines[index + 1] ?? "")) {
            body.push("");
            index += 1;
          } else {
            break;
          }
        }
        items.push(parseBlocks(body, depth + 1, state));
      }
      blocks.push({
        type: "list",
        ordered: first.ordered,
        ...(first.start !== undefined && first.start !== 1 ? { start: first.start } : {}),
        items,
      });
      continue;
    }

    const divider = lines[index + 1];
    if (
      line.includes("|") &&
      divider !== undefined &&
      !isLongLine(divider) &&
      isTableDivider(divider)
    ) {
      state.steps += divider.length + 1;
      const table = parseTable(lines, index, depth, state);
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !state.truncated) {
      const next = lines[index]!;
      state.steps += next.length + 1;
      if (isBlank(next) || isLongLine(next)) break;
      if (paragraph.length > 0 && isBlockStart(next, state)) break;
      // Every collected line yields at least one node, so lines past the budget never render.
      if (paragraph.length > MAX_MARKDOWN_NODES - state.nodes) break;
      paragraph.push(next.trim());
      index += 1;
    }
    const children: MarkdownInline[] = [];
    for (const [position, text] of paragraph.entries()) {
      if (position > 0 && spend(state)) children.push({ type: "text", text: " " });
      children.push(...parseInline(text, depth, state));
      if (state.truncated) break;
    }
    blocks.push({ type: "paragraph", children });
  }
  return blocks;
}

/**
 * Parse the table whose header is `lines[start]`, reading body rows up to the budget; returns
 * the table and the index of the first line after it.
 */
function parseTable(
  lines: readonly string[],
  start: number,
  depth: number,
  state: ParseState,
): { block: MarkdownBlock; next: number } {
  const header = tableCells(lines[start]!, MAX_TABLE_COLUMNS);
  const columns = header.cells.length;
  const align = tableCells(lines[start + 1]!, columns).cells.map(cellAlign);
  let clipped = header.clipped;

  const headerCells: MarkdownInline[][] = [];
  for (const cell of header.cells) {
    if (!spend(state)) break;
    headerCells.push(parseInline(cell, depth, state));
  }

  const rows: MarkdownInline[][][] = [];
  let index = start + 2;
  while (index < lines.length && !state.truncated) {
    const line = lines[index]!;
    state.steps += line.length + 1;
    if (isLongLine(line) || !line.includes("|") || isBlank(line)) break;
    const row = tableCells(line, columns);
    clipped ||= row.clipped;
    if (!spend(state, row.cells.length)) break;
    rows.push(row.cells.map((cell) => parseInline(cell, depth, state)));
    index += 1;
  }

  const block: MarkdownBlock = {
    type: "table",
    align,
    header: headerCells,
    rows,
    ...(clipped ? { clipped: true as const } : {}),
  };
  return { block, next: index };
}
