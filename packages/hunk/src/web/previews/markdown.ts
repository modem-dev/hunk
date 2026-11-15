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
 * - Inline lookahead (`]`, link targets, code-span closers) is answered from tables built once
 *   per line, so repeated unmatched openers never rescan. Emphasis delimiters are paired in one
 *   delimiter-stack pass per line (CommonMark's flanking rules, with code spans, links, and
 *   escapes skipped as units), not searched for opener by opener.
 * - Lines longer than `MAX_BLOCK_LINE_LENGTH` skip block detection and render as paragraph
 *   text; lines longer than `MAX_INLINE_LINE_LENGTH` are not scanned for inline markup.
 * - Tables keep at most `MAX_TABLE_COLUMNS` columns and never pad short rows; cells past the
 *   header's column count are dropped quietly, and only cells past the column cap mark the
 *   table clipped. A document
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
      /** Set when the header or a row of a full-width table had cells past `MAX_TABLE_COLUMNS`. */
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

/**
 * Whether a continuation line is indented by at least two columns, a tab counting as the run
 * to the next multiple of four, so `\t- nested` continues the list item above it.
 */
function isIndentedContinuation(line: string) {
  let width = 0;
  let index = 0;
  while (index < line.length) {
    if (line[index] === " ") width += 1;
    else if (line[index] === "\t") width += 4 - (width % 4);
    else break;
    index += 1;
  }
  return width >= 2 && skipSpaces(line, index) < line.length;
}

/** Remove up to `width` columns of leading whitespace; a tab straddling the edge leaves spaces. */
function dedent(line: string, width: number) {
  let column = 0;
  let index = 0;
  while (index < line.length && column < width) {
    if (line[index] === " ") {
      column += 1;
    } else if (line[index] === "\t") {
      const span = 4 - (column % 4);
      if (column + span > width) return " ".repeat(column + span - width) + line.slice(index + 1);
      column += span;
    } else {
      break;
    }
    index += 1;
  }
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

/** How many cells a table row or delimiter row has, up to the column cap. */
function tableColumnCount(line: string) {
  return tableCells(line, MAX_TABLE_COLUMNS).cells.length;
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

/** One run of emphasis delimiter characters, for the delimiter-stack pass. */
interface DelimiterRun {
  character: string;
  /** Index of the run's first character. */
  position: number;
  /** The run's original length. */
  count: number;
  /** Characters not yet used by a matched pair. */
  remaining: number;
  canOpen: boolean;
  canClose: boolean;
}

/** One matched emphasis pair, keyed by the index of the opener's leftmost delimiter character. */
interface EmphasisPair {
  /** Index of the closer's leftmost delimiter character. */
  close: number;
  length: 1 | 2;
}

/**
 * Pair the `*`, `_`, and `~~` delimiters of one line, as CommonMark's delimiter-stack
 * algorithm does: left- and right-flanking rules decide which runs can open or close, the
 * nearest compatible opener wins, delimiters between a pair are dropped, and a failed search
 * raises a floor so no closer rescans openers already ruled out. `atomicEnd` skips escapes,
 * code spans, links, and autolinks, whose contents never delimit emphasis of the surrounding
 * text. The work is linear in the line.
 */
function matchEmphasisPairs(
  text: string,
  atomicEnd: (index: number) => number,
  state: ParseState,
): Map<number, EmphasisPair> {
  const runs: DelimiterRun[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "*" || character === "_" || character === "~") {
      const count = runLength(text, index, character);
      // Strikethrough is exactly `~~`; other runs of tildes are literal.
      if (character !== "~" || count === 2) {
        const before = text[index - 1];
        const after = text[index + count];
        const beforeSpace = before === undefined || isSpace(before);
        const afterSpace = after === undefined || isSpace(after);
        const beforePunctuation = isAsciiPunctuation(before);
        const afterPunctuation = isAsciiPunctuation(after);
        const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
        const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
        runs.push({
          character,
          position: index,
          count,
          remaining: count,
          // Intraword underscores (snake_case) neither open nor close.
          canOpen: character === "_" ? left && (!right || beforePunctuation) : left,
          canClose: character === "_" ? right && (!left || afterPunctuation) : right,
        });
      }
      index += count;
      continue;
    }
    if (INLINE_STARTERS.has(character)) {
      const end = atomicEnd(index);
      if (end > index) {
        index = end;
        continue;
      }
    }
    index += 1;
  }
  state.steps += text.length + runs.length + 1;

  const pairs = new Map<number, EmphasisPair>();
  // Each run's nearest earlier run still in play, and per kind of closer the run index below
  // which no opener can match (CommonMark's `openers_bottom`).
  const previous = runs.map((_run, position) => position - 1);
  const floors = new Map<string, number>();
  for (let closerIndex = 0; closerIndex < runs.length; closerIndex += 1) {
    const closer = runs[closerIndex]!;
    if (!closer.canClose) continue;
    const floorKey = `${closer.character}${closer.canOpen ? 1 : 0}${closer.count % 3}`;
    while (closer.remaining > 0) {
      const floor = floors.get(floorKey) ?? -1;
      let openerIndex = previous[closerIndex]!;
      let opener: DelimiterRun | undefined;
      while (openerIndex > floor) {
        const candidate = runs[openerIndex]!;
        state.steps += 1;
        // The rule of three: a run that can both open and close matches only if the lengths
        // do not sum to a multiple of three (unless both are multiples of three).
        const blocked =
          (candidate.canClose || closer.canOpen) &&
          (candidate.count + closer.count) % 3 === 0 &&
          !(candidate.count % 3 === 0 && closer.count % 3 === 0);
        if (
          candidate.character === closer.character &&
          candidate.canOpen &&
          candidate.remaining > 0 &&
          !blocked
        ) {
          opener = candidate;
          break;
        }
        openerIndex = previous[openerIndex]!;
      }
      if (!opener) {
        floors.set(floorKey, previous[closerIndex]!);
        break;
      }

      const length =
        closer.character === "~" ? 2 : opener.remaining >= 2 && closer.remaining >= 2 ? 2 : 1;
      pairs.set(opener.position + opener.remaining - length, {
        close: closer.position + (closer.count - closer.remaining),
        length: length as 1 | 2,
      });
      opener.remaining -= length;
      closer.remaining -= length;
      // Delimiters between the pair can no longer match anything outside it.
      previous[closerIndex] = opener.remaining > 0 ? openerIndex : previous[openerIndex]!;
    }
  }
  return pairs;
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
  let pairs: Map<number, EmphasisPair> | undefined;

  /** The link or image starting at `index` (`[` or `![`), with its closing bracket and target. */
  const linkAt = (index: number) => {
    const open = text[index] === "!" ? index + 1 : index;
    if (text[open] !== "[") return undefined;
    tables ??= buildLinkTables(text, state);
    const close = tables.nextCloseBracket[open + 1]!;
    // A link needs text; an image may have an empty alt.
    if (open === index && close <= open + 1) return undefined;
    const destination =
      text[close + 1] === "(" ? linkDestination(text, close + 2, tables) : undefined;
    return destination ? { open, close, destination } : undefined;
  };

  /** The `<https://…>` autolink starting at `index`: the scan stops at the next `<`. */
  const autolinkAt = (index: number) => {
    const schemeEnd = text.startsWith("http://", index + 1)
      ? index + 8
      : text.startsWith("https://", index + 1)
        ? index + 9
        : -1;
    if (schemeEnd < 0) return undefined;
    let end = schemeEnd;
    while (end < text.length && !isSpace(text[end]) && text[end] !== "<" && text[end] !== ">") {
      end += 1;
    }
    state.steps += end - index;
    const href =
      end > schemeEnd && text[end] === ">"
        ? safeMarkdownHref(text.slice(index + 1, end))
        : undefined;
    return href ? { end, href } : undefined;
  };

  /** The index after the escape, code span, link, or autolink at `index`; `index` if none. */
  const atomicEnd = (index: number) => {
    const character = text[index];
    if (character === "\\") return isAsciiPunctuation(text[index + 1]) ? index + 2 : index;
    if (character === "`") {
      const length = runLength(text, index, "`");
      backticks ??= new BacktickRuns(text, state);
      const close = backticks.next(length, index + length);
      return close >= 0 ? close + length : index + length;
    }
    if (character === "!" || character === "[") {
      const link = linkAt(index);
      return link ? link.destination.next : index;
    }
    if (character === "<") {
      const autolink = autolinkAt(index);
      return autolink ? autolink.end + 1 : index;
    }
    return index;
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
      const image = linkAt(index);
      if (image) {
        buffer += text.slice(index + 2, image.close);
        index = image.destination.next;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    // `[text](target)`: targets may hold one level of balanced parentheses, as URLs often do.
    if (character === "[") {
      const link = linkAt(index);
      if (link) {
        if (!flush()) break;
        const children = parseInline(text.slice(index + 1, link.close), depth + 1, state);
        const href = safeMarkdownHref(link.destination.target);
        if (href) {
          if (!emit({ type: "link", href, children })) break;
        } else {
          nodes.push(...children);
        }
        index = link.destination.next;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    // `<https://…>`.
    if (character === "<") {
      const autolink = autolinkAt(index);
      if (autolink) {
        if (!flush()) break;
        if (
          !emit({
            type: "link",
            href: autolink.href,
            children: [{ type: "text", text: text.slice(index + 1, autolink.end) }],
          })
        )
          break;
        index = autolink.end + 1;
        continue;
      }
      buffer += character;
      index += 1;
      continue;
    }

    // Emphasis delimiters are `*`, `_`, and `~~` only; every other inline starter that got this
    // far (`!` without `[`, a `\` before a non-punctuation character) is literal text. A
    // delimiter character the pairing pass left unmatched is literal too.
    if (character === "*" || character === "_" || character === "~") {
      pairs ??= matchEmphasisPairs(text, atomicEnd, state);
      const pair = pairs.get(index);
      if (pair) {
        if (!flush()) break;
        const children = parseInline(text.slice(index + pair.length, pair.close), depth + 1, state);
        const type = character === "~" ? "strike" : pair.length === 2 ? "strong" : "emphasis";
        if (!emit({ type, children })) break;
        index = pair.close + pair.length;
        continue;
      }
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
        // Blank lines between items keep one (loose) list when the next item is the same kind.
        if (items.length > 0 && isBlank(lines[index]!)) {
          let resume = index;
          while (resume < lines.length && isBlank(lines[resume]!)) resume += 1;
          state.steps += resume - index;
          const next =
            resume < lines.length && !isLongLine(lines[resume]!) && !isRule(lines[resume]!)
              ? listMarker(lines[resume]!)
              : undefined;
          if (!next || next.ordered !== first.ordered) break;
          index = resume;
        }
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
      isTableDivider(divider) &&
      tableColumnCount(line) === tableColumnCount(divider)
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
    // Cells past the header's width are dropped quietly, as Markdown renderers do; only a row
    // cut by the column cap itself marks the table clipped.
    const row = tableCells(line, columns);
    clipped ||= row.clipped && columns === MAX_TABLE_COLUMNS;
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
