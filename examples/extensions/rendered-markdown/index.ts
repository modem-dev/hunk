import { Lexer, type Token, type Tokens } from "marked";
import type {
  ExtensionFactory,
  ExtensionFileChangeRange,
  ExtensionFileViewRow,
  ExtensionFileViewSpan,
} from "hunkdiff/extension";

const MAX_MARKDOWN_SOURCE_LENGTH = 200_000;

interface SourceIndex {
  lineAt(offset: number): number;
  range(offset: number, length: number): [number, number];
}

interface RenderedMarkdownRow {
  spans: ExtensionFileViewSpan[];
  sourceRange: [number, number];
}

type SpanPresentation = Omit<ExtensionFileViewSpan, "text">;
type FileViewTextAttribute = NonNullable<ExtensionFileViewSpan["attributes"]>[number];

/** Index source offsets once so token-to-line mapping stays linear for large documents. */
function createSourceIndex(source: string): SourceIndex {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }

  const lineAt = (offset: number) => {
    const target = Math.max(0, Math.min(source.length, offset));
    let low = 0;
    let high = lineStarts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle]! <= target) low = middle + 1;
      else high = middle;
    }
    return Math.max(1, low);
  };

  return {
    lineAt,
    range(offset, length) {
      return [lineAt(offset), lineAt(offset + Math.max(0, length - 1))];
    },
  };
}

/** Decode the entities Markdown permits in ordinary text without creating HTML. */
function decodeMarkdownEntities(text: string) {
  return text.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (entity, decimal, hex, named) => {
    if (decimal || hex) {
      const value = Number.parseInt(decimal ?? hex, decimal ? 10 : 16);
      return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : entity;
    }
    const entities: Record<string, string> = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      quot: '"',
    };
    return entities[String(named).toLowerCase()] ?? entity;
  });
}

/** Append terminal-safe inline text while preserving explicit Markdown line breaks. */
function appendInlineText(
  lines: ExtensionFileViewSpan[][],
  text: string,
  presentation: SpanPresentation,
) {
  const parts = decodeMarkdownEntities(text).split("\n");
  parts.forEach((part, index) => {
    if (index > 0) lines.push([]);
    if (part.length > 0) lines.at(-1)!.push({ text: part, ...presentation });
  });
}

/** Merge nested inline output into the current line without losing hard breaks. */
function appendInlineLines(target: ExtensionFileViewSpan[][], nested: ExtensionFileViewSpan[][]) {
  target.at(-1)!.push(...(nested[0] ?? []));
  for (const line of nested.slice(1)) target.push([...line]);
}

/** Add one generic text attribute without coupling the host to Markdown semantics. */
function withAttribute(
  presentation: SpanPresentation,
  attribute: FileViewTextAttribute,
): SpanPresentation {
  return {
    ...presentation,
    attributes: [...(presentation.attributes ?? []), attribute],
  };
}

/** Convert Marked inline tokens into generic symbolic host-rendered spans. */
function renderInlineTokens(
  tokens: readonly Token[] | undefined,
  presentation: SpanPresentation = {},
): ExtensionFileViewSpan[][] {
  const lines: ExtensionFileViewSpan[][] = [[]];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "br":
        lines.push([]);
        break;
      case "codespan":
        appendInlineText(lines, token.text, { tone: "syntax" });
        break;
      case "strong":
        appendInlineLines(
          lines,
          renderInlineTokens(token.tokens, withAttribute(presentation, "bold")),
        );
        break;
      case "em":
        appendInlineLines(
          lines,
          renderInlineTokens(token.tokens, withAttribute(presentation, "italic")),
        );
        break;
      case "del":
        appendInlineLines(
          lines,
          renderInlineTokens(
            token.tokens,
            withAttribute({ ...presentation, tone: "muted" }, "strikethrough"),
          ),
        );
        break;
      case "link": {
        const linkPresentation = withAttribute({ ...presentation, tone: "accent" }, "underline");
        appendInlineLines(lines, renderInlineTokens(token.tokens, linkPresentation));
        if (token.href && token.href !== token.text) {
          appendInlineText(lines, ` <${token.href}>`, { tone: "muted" });
        }
        break;
      }
      case "image":
        appendInlineText(lines, `▣ ${token.text || token.href}`, {
          tone: "accent",
          attributes: ["underline"],
        });
        break;
      case "checkbox":
        appendInlineText(lines, token.checked ? "[x] " : "[ ] ", presentation);
        break;
      case "html": {
        const visible = token.text.replace(/<[^>]*>/g, "");
        if (visible) appendInlineText(lines, visible, presentation);
        break;
      }
      default:
        if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
          appendInlineLines(lines, renderInlineTokens(token.tokens, presentation));
        } else if ("text" in token && typeof token.text === "string") {
          appendInlineText(lines, token.text, presentation);
        }
    }
  }
  return lines;
}

/** Ensure every symbolic row occupies at least one visible terminal cell. */
function nonEmptySpans(
  spans: ExtensionFileViewSpan[],
  presentation: SpanPresentation = {},
): ExtensionFileViewSpan[] {
  return spans.length > 0 ? spans : [{ text: " ", ...presentation }];
}

/** Render one parsed Markdown block without exposing an OpenTUI renderable to extensions. */
function renderBlock(
  token: Token,
  sourceRange: [number, number],
  width: number,
): RenderedMarkdownRow[] {
  const rows = (lines: ExtensionFileViewSpan[][], fallback?: SpanPresentation) =>
    lines.map((spans) => ({ spans: nonEmptySpans(spans, fallback), sourceRange }));

  switch (token.type) {
    case "space":
      return rows([[]]);
    case "heading": {
      const heading = { tone: "accent" as const, attributes: ["bold" as const] };
      return rows(renderInlineTokens((token as Tokens.Heading).tokens, heading), heading);
    }
    case "paragraph":
    case "text":
      return rows(renderInlineTokens((token as Tokens.Paragraph | Tokens.Text).tokens));
    case "hr":
      return rows([[{ text: "─".repeat(Math.max(1, width)), tone: "muted" }]]);
    case "code": {
      const code = token as Tokens.Code;
      const fenced = /^\s{0,3}(?:`{3,}|~{3,})/.test(code.raw);
      const codeLines = code.text.split("\n");
      const output: RenderedMarkdownRow[] = [];
      if (fenced) {
        output.push({
          spans: [{ text: `┌─${code.lang ? ` ${code.lang.trim()}` : ""}`, tone: "muted" }],
          sourceRange: [sourceRange[0], sourceRange[0]],
        });
      }
      codeLines.forEach((line, index) => {
        const sourceLine = Math.min(sourceRange[1], sourceRange[0] + index + (fenced ? 1 : 0));
        output.push({
          spans: [{ text: `${fenced ? "│ " : "  "}${line || " "}`, tone: "syntax" }],
          sourceRange: [sourceLine, sourceLine],
        });
      });
      if (fenced) {
        output.push({
          spans: [{ text: "└─", tone: "muted" }],
          sourceRange: [sourceRange[1], sourceRange[1]],
        });
      }
      return output;
    }
    case "blockquote": {
      const quote = { tone: "accent-muted" as const };
      return rows(renderInlineTokens((token as Tokens.Blockquote).tokens, quote), quote).map(
        (row) => ({
          ...row,
          spans: [{ text: "│ ", ...quote }, ...row.spans],
        }),
      );
    }
    case "list": {
      const list = token as Tokens.List;
      const output: RenderedMarkdownRow[] = [];
      list.items.forEach((item: Tokens.ListItem, itemIndex: number) => {
        const itemLines = renderInlineTokens(item.tokens);
        const marker = item.task
          ? item.checked
            ? "[x] "
            : "[ ] "
          : list.ordered
            ? `${Number(list.start || 1) + itemIndex}. `
            : "• ";
        itemLines.forEach((spans, lineIndex) => {
          output.push({
            sourceRange,
            spans: [
              { text: lineIndex === 0 ? marker : " ".repeat(marker.length), tone: "muted" },
              ...nonEmptySpans(spans),
            ],
          });
        });
      });
      return output;
    }
    case "table": {
      const table = token as Tokens.Table;
      const cellText = (cell: Tokens.TableCell) =>
        renderInlineTokens(cell.tokens)
          .flat()
          .map((span) => span.text)
          .join("");
      const output: RenderedMarkdownRow[] = [];
      const header = table.header.map(cellText);
      output.push({
        sourceRange: [sourceRange[0], sourceRange[0]],
        spans: [{ text: header.join(" │ ") }],
      });
      output.push({
        sourceRange: [
          Math.min(sourceRange[1], sourceRange[0] + 1),
          Math.min(sourceRange[1], sourceRange[0] + 1),
        ],
        spans: [
          {
            text: header.map((cell) => "─".repeat(Math.max(1, cell.length))).join("─┼─"),
            tone: "muted",
          },
        ],
      });
      table.rows.forEach((cells: Tokens.TableCell[], index: number) => {
        const sourceLine = Math.min(sourceRange[1], sourceRange[0] + index + 2);
        output.push({
          sourceRange: [sourceLine, sourceLine],
          spans: [{ text: cells.map(cellText).join(" │ ") }],
        });
      });
      return output;
    }
    case "html": {
      const visible = (token as Tokens.HTML).text.replace(/<[^>]*>/g, "").trim();
      return rows([[{ text: visible || " " }]]);
    }
    case "def":
      return rows([[]]);
    default:
      return rows(
        renderInlineTokens(
          "tokens" in token && Array.isArray(token.tokens) ? token.tokens : undefined,
        ),
      );
  }
}

/** Parse and render Markdown blocks while retaining internal source ranges for hunk geometry. */
function renderMarkdown(source: string, width: number): RenderedMarkdownRow[] {
  const tokens = Lexer.lex(source, { gfm: true });
  const sourceIndex = createSourceIndex(source);
  const rows: RenderedMarkdownRow[] = [];
  let offset = 0;
  for (const token of tokens) {
    const range = sourceIndex.range(offset, token.raw.length);
    rows.push(...renderBlock(token, range, width));
    offset += token.raw.length;
  }
  return rows;
}

/** Reject ambiguous unterminated fenced blocks instead of previewing guessed structure. */
function hasUnterminatedFence(source: string) {
  let fence: { marker: string; length: number } | null = null;
  for (const line of source.split("\n")) {
    const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const run = match[1]!;
    if (!fence) {
      fence = { marker: run[0]!, length: run.length };
      continue;
    }
    if (
      run[0] === fence.marker &&
      run.length >= fence.length &&
      (match[2]?.trim().length ?? 0) === 0
    ) {
      fence = null;
    }
  }
  return fence !== null;
}

/** Check whether one rendered row overlaps an added new-side source range. */
function rowWasAdded(row: RenderedMarkdownRow, changes: readonly ExtensionFileChangeRange[]) {
  return changes.some(
    (change) =>
      change.kind === "added" &&
      change.range[0] <= row.sourceRange[1] &&
      change.range[1] >= row.sourceRange[0],
  );
}

/** Resolve an inclusive source range to the rendered rows that best represent it. */
function renderedBounds(
  rows: readonly RenderedMarkdownRow[],
  range: readonly [number, number],
): [number, number] {
  const overlapping = rows.flatMap((row, index) =>
    row.sourceRange[0] <= range[1] && row.sourceRange[1] >= range[0] ? [index] : [],
  );
  if (overlapping.length > 0) return [overlapping[0]!, overlapping.at(-1)!];

  const nearest = rows.reduce(
    (best, row, index) => {
      const distance =
        range[0] < row.sourceRange[0]
          ? row.sourceRange[0] - range[0]
          : range[0] > row.sourceRange[1]
            ? range[0] - row.sourceRange[1]
            : 0;
      return distance < best.distance ? { distance, index } : best;
    },
    { distance: Number.POSITIVE_INFINITY, index: 0 },
  ).index;
  return [nearest, nearest];
}

/** Build a parsed, host-rendered Markdown preview from exact source text. */
const renderedMarkdownExtension: ExtensionFactory = (hunk) => {
  hunk.registerCommand(
    {
      id: "toggle-rendered-markdown",
      title: "Toggle rendered Markdown",
      key: "f8",
    },
    ({ fileViews }) => fileViews.toggle("rendered-markdown"),
  );
  hunk.registerFileView({
    id: "rendered-markdown",
    title: "Rendered Markdown",
    matches(file) {
      return /\.md(?:own)?$/i.test(file.path) && !file.isBinary && !file.isTooLarge;
    },
    async layout(input) {
      const source = await input.readDocument("new");
      if (
        !source ||
        source.length > MAX_MARKDOWN_SOURCE_LENGTH ||
        input.signal.aborted ||
        hasUnterminatedFence(source)
      ) {
        return null;
      }

      const renderedRows = renderMarkdown(source, input.width);
      if (renderedRows.length === 0) return null;
      let lastBoundLine = 0;
      const rows: ExtensionFileViewRow[] = renderedRows.map((row, index) => {
        // Wrapped visual rows from one Markdown block share a source range. Bind the first row only
        // so every source line has one unambiguous host-note anchor.
        const sourceRange = row.sourceRange[0] > lastBoundLine ? row.sourceRange : undefined;
        if (sourceRange) lastBoundLine = sourceRange[1];
        return {
          id: `rendered:${index}`,
          spans: rowWasAdded(row, input.changes)
            ? row.spans.map((span) => ({ ...span, tone: "added" as const }))
            : row.spans,
          ...(sourceRange === undefined
            ? {}
            : { sourceRanges: [{ side: "new" as const, range: sourceRange }] }),
        };
      });
      const hunkRows = (input.file.hunks ?? []).map((hunk) => {
        const changedRanges = input.changes.filter(
          (change) => change.hunkIndex === hunk.index && change.kind === "added",
        );
        const sourceRange: [number, number] = changedRanges.length
          ? [
              Math.min(...changedRanges.map((change) => change.range[0])),
              Math.max(...changedRanges.map((change) => change.range[1])),
            ]
          : (hunk.newRange ?? [1, 1]);
        const [startRow, endRow] = renderedBounds(renderedRows, sourceRange);
        return { startRow, endRow };
      });

      // A rendered row shared by adjacent hunk extents cannot own one note-navigation target.
      const unambiguousRows = rows.map((row, rowIndex) => {
        const ownerCount = hunkRows.filter(
          (hunkRows) => rowIndex >= hunkRows.startRow && rowIndex <= hunkRows.endRow,
        ).length;
        if (ownerCount === 1 || row.sourceRanges === undefined) return row;
        const { sourceRanges: _ambiguous, ...unboundRow } = row;
        return unboundRow;
      });

      return { rows: unambiguousRows, hunkRows };
    },
  });
};

export default renderedMarkdownExtension;
