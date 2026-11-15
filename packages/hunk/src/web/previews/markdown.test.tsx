/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_BLOCK_LINE_LENGTH,
  MAX_INLINE_LINE_LENGTH,
  MAX_MARKDOWN_NESTING,
  MAX_MARKDOWN_PREVIEW_BYTES,
  MAX_MARKDOWN_NODES,
  MAX_TABLE_COLUMNS,
  parseMarkdown,
  parseMarkdownInline,
  parseMarkdownWithStats,
  safeMarkdownHref,
  type MarkdownBlock,
  type MarkdownInline,
} from "./markdown";
import { REVIEW_SOURCE_CONTENT_TYPE } from "../../core/review/resources";
import { MarkdownPreview, markdownTooLargeMessage } from "./MarkdownPreview";
import { MarkdownView } from "./MarkdownView";
import { MarkdownModeStore, PreviewContext, type PreviewContextValue } from "./previewContext";

/** Render Markdown to the HTML the preview would put on the page. */
function renderTest(source: string) {
  return renderToStaticMarkup(<MarkdownView document={parseMarkdown(source)} />);
}

describe("Markdown preview", () => {
  test("renders the supported blocks", () => {
    const html = renderTest(
      [
        "# Title",
        "",
        "Some *em*, **strong**, ~~gone~~, and `code`.",
        "",
        "- one",
        "- two",
        "  - nested",
        "",
        "3. three",
        "4. four",
        "",
        "> quoted",
        "",
        "---",
        "",
        "| a | b |",
        "|:--|--:|",
        "| 1 | 2 |",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    );

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain(
      "<ul><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li></ul>",
    );
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(html).toContain("<hr/>");
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
    expect(html).toContain('<pre data-language="ts"><code>const x = 1;</code></pre>');
  });

  test("treats raw HTML as text", () => {
    const html = renderTest('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">');

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  test("links only to http and https, in a new tab without an opener", () => {
    const html = renderTest(
      "[ok](https://example.com/a?b=1) [js](javascript:alert(1)) [data](data:text/html,x) [rel](../x) <http://example.org>",
    );

    expect(html).toContain(
      '<a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">ok</a>',
    );
    expect(html).toContain(
      '<a href="http://example.org/" target="_blank" rel="noopener noreferrer">',
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).toContain(" js data rel ");
    expect(safeMarkdownHref("JAVASCRIPT:alert(1)")).toBeUndefined();
    expect(safeMarkdownHref(" https://x.test ")).toBe("https://x.test/");
  });

  test("shows images as their alt text and loads nothing", () => {
    expect(renderTest("![a diagram](https://example.com/x.png)")).toBe(
      '<div class="markdown-view"><p>a diagram</p></div>',
    );
  });

  test("nests emphasis, keeps snake_case words, and caps nesting depth", () => {
    expect(parseMarkdownInline("**bold _and em_**")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", text: "bold " },
          { type: "emphasis", children: [{ type: "text", text: "and em" }] },
        ],
      },
    ]);
    // An ambiguous run degrades to text rather than to broken markup.
    expect(renderTest("**bold *and em***")).toBe(
      '<div class="markdown-view"><p><strong>bold *and em</strong>*</p></div>',
    );
    expect(parseMarkdownInline("call snake_case_name now")).toEqual([
      { type: "text", text: "call snake_case_name now" },
    ]);
    const deep = `${"> ".repeat(200)}deep`;
    expect(() => renderTest(deep)).not.toThrow();
    expect(renderTest(deep)).toContain("deep");
  });

  test("runs an unterminated fence to the end and leaves it as code", () => {
    const blocks = parseMarkdown("before\n\n```\n# not a heading\n<b>x</b>");

    expect(blocks.at(-1)).toEqual({ type: "code", text: "# not a heading\n<b>x</b>" });
  });

  test("keeps very long and delimiter-heavy lines fast and literal", () => {
    const long = `${"_a".repeat(MAX_INLINE_LINE_LENGTH)} *x*`;
    const started = performance.now();
    expect(parseMarkdownInline(long)).toEqual([{ type: "text", text: long }]);
    const stars = `a${"*".repeat(9_000)}`;
    expect(renderTest(stars)).toContain("a*");
    const unmatched = "_x ".repeat(3_000);
    parseMarkdownInline(unmatched);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

/** Count a tree's nodes plus its text characters: the size of what the renderer would build. */
function treeTestSize(nodes: ReadonlyArray<MarkdownBlock | MarkdownInline>): number {
  let size = 0;
  for (const node of nodes) {
    size += 1;
    if ("text" in node) size += node.text.length;
    if ("children" in node) size += treeTestSize(node.children);
    if (node.type === "list") for (const item of node.items) size += treeTestSize(item);
    if (node.type === "table") {
      for (const cell of node.header) size += treeTestSize(cell);
      for (const row of node.rows) for (const cell of row) size += treeTestSize(cell);
    }
  }
  return size;
}

/** Repeat one line, newline-separated, until the document reaches about `total` characters. */
function repeatTestLine(line: string, total: number) {
  return Array.from({ length: Math.ceil(total / (line.length + 1)) }, () => line).join("\n");
}

const KB = 1024;
const BELOW_CAP = MAX_BLOCK_LINE_LENGTH - 10;

/**
 * Hostile inputs from the security review, at full size and as lines just under the block cap
 * (so the block recognizers, not the long-line fallback, see them). `budgetMs` is a backstop
 * with at least 10× headroom over a quiet machine; the work and output assertions are the
 * real proof of linearity.
 */
const ADVERSARIAL_TEST_INPUTS: Array<{ name: string; source: string; budgetMs: number }> = [
  {
    name: "heading padded with spaces, 100 KB",
    source: `# a${" ".repeat(100 * KB)}x`,
    budgetMs: 250,
  },
  {
    name: "heading padded with tabs, 100 KB",
    source: `# a${"\t".repeat(100 * KB)}x`,
    budgetMs: 250,
  },
  {
    name: "heading lines padded with spaces, 100 KB",
    source: repeatTestLine(`# a${" ".repeat(BELOW_CAP)}x`, 100 * KB),
    budgetMs: 250,
  },
  {
    name: "heading lines padded with tabs, 100 KB",
    source: repeatTestLine(`# a${"\t".repeat(BELOW_CAP)}x`, 100 * KB),
    budgetMs: 250,
  },
  {
    name: "fence opener ending in a backtick, 500 KB",
    source: `\`\`\`${"a".repeat(500 * KB)}\``,
    budgetMs: 1000,
  },
  {
    name: "fence opener lines ending in a backtick, 500 KB",
    source: repeatTestLine(`\`\`\`${"a b".repeat(BELOW_CAP / 3)}\``, 500 * KB),
    budgetMs: 1000,
  },
  {
    name: "divider-like line of spaces, 500 KB",
    source: `a|b\n${" ".repeat(500 * KB)}x`,
    budgetMs: 1000,
  },
  {
    name: "divider-like lines under tables, 500 KB",
    source: repeatTestLine(`a|b\n|${" ".repeat(BELOW_CAP)}x`, 500 * KB),
    budgetMs: 1000,
  },
  {
    name: "2,000-column header over 2,000 one-pipe rows",
    source: `${"|a".repeat(2000)}\n|-|\n${"|\n".repeat(2000)}`,
    budgetMs: 250,
  },
  {
    name: "1 MB single line",
    source: "a *b [c](d ".repeat(100 * KB).slice(0, 1024 * KB),
    budgetMs: 1000,
  },
  { name: "1 MB of 1-character lines", source: "a\n".repeat(512 * KB), budgetMs: 1000 },
  {
    name: "deeply nested quotes, 500 KB",
    source: repeatTestLine(`${"> ".repeat(BELOW_CAP / 2)}x`, 500 * KB),
    budgetMs: 1000,
  },
  {
    name: "deeply nested lists, 500 KB",
    source: repeatTestLine(
      Array.from({ length: 40 }, (_unused, depth) => `${"  ".repeat(depth)}- item`).join("\n"),
      500 * KB,
    ),
    budgetMs: 1000,
  },
  {
    name: "unclosed link brackets, 500 KB",
    source: repeatTestLine(`${"[".repeat(BELOW_CAP)}](`, 500 * KB),
    budgetMs: 1000,
  },
  {
    name: "overlapping failed link targets, 500 KB",
    source: repeatTestLine(`[x](${"q(r)[y](s)".repeat(BELOW_CAP / 10 - 1)} `, 500 * KB),
    budgetMs: 1000,
  },
  {
    name: "unmatched emphasis and code delimiters, 500 KB",
    source: repeatTestLine("*a _b ~~c `d ".repeat(Math.floor(BELOW_CAP / 13)), 500 * KB),
    budgetMs: 1000,
  },
  {
    name: "backtick runs of every length, 500 KB",
    source: repeatTestLine(
      Array.from({ length: 139 }, (_unused, index) => `${"`".repeat(index + 1)}x`).join(""),
      500 * KB,
    ),
    budgetMs: 1000,
  },
];

describe("Markdown preview on hostile input", () => {
  for (const { name, source, budgetMs } of ADVERSARIAL_TEST_INPUTS) {
    test(`parses linearly with bounded output: ${name}`, () => {
      const started = performance.now();
      const result = parseMarkdownWithStats(source);
      const elapsed = performance.now() - started;

      // Each nesting level re-reads its container's lines a bounded number of times.
      expect(result.steps).toBeLessThanOrEqual((MAX_MARKDOWN_NESTING + 8) * (source.length + 1));
      expect(result.nodes).toBeLessThanOrEqual(MAX_MARKDOWN_NODES);
      expect(treeTestSize(result.blocks)).toBeLessThanOrEqual(2 * source.length + 64);
      expect(elapsed).toBeLessThan(budgetMs);
    });
  }

  test("caps table columns and never pads short rows", () => {
    const blocks = parseMarkdown(`${"|a".repeat(2000)}\n|-|\n${"|\n".repeat(2000)}`);
    const table = blocks[0] as Extract<MarkdownBlock, { type: "table" }>;

    expect(table.header).toHaveLength(MAX_TABLE_COLUMNS);
    expect(table.clipped).toBe(true);
    expect(table.rows).toHaveLength(2000);
    expect(Math.max(...table.rows.map((row) => row.length))).toBeLessThanOrEqual(1);
    expect(renderTest(`| a | b |\n|---|---|\n${"| x ".repeat(100)}|`)).toContain(
      `Columns past the first ${MAX_TABLE_COLUMNS} are not shown.`,
    );
  });

  test("stops at the node budget with a visible marker", () => {
    const result = parseMarkdownWithStats("a\n".repeat(512 * KB));

    expect(result.truncated).toBe(true);
    expect(result.blocks.at(-1)).toEqual({ type: "truncated" });
    expect(renderTest("x\n\n".repeat(MAX_MARKDOWN_NODES))).toContain("Preview truncated");
    expect(parseMarkdownWithStats("# small\n\ntext").truncated).toBe(false);
  });

  test("renders lines past the block cap as paragraph text, whatever they start with", () => {
    const long = `# ${"x".repeat(MAX_BLOCK_LINE_LENGTH)}`;

    expect(parseMarkdown(long)).toEqual([
      { type: "paragraph", children: [{ type: "text", text: long }] },
    ]);
    expect(parseMarkdown(`> ${"y".repeat(MAX_BLOCK_LINE_LENGTH)}`)[0]!.type).toBe("paragraph");
    // A long line inside an open fence stays code.
    const fenced = `\`\`\`\n${"z".repeat(MAX_BLOCK_LINE_LENGTH + 1)}\n\`\`\``;
    expect(parseMarkdown(fenced)[0]!.type).toBe("code");
  });

  test("strips closing heading sequences only after whitespace", () => {
    const heading = (source: string) => {
      const block = parseMarkdown(source)[0] as Extract<MarkdownBlock, { type: "heading" }>;
      return { level: block.level, children: block.children };
    };

    expect(heading("## Title ##")).toEqual({
      level: 2,
      children: [{ type: "text", text: "Title" }],
    });
    expect(heading("# Title#")).toEqual({ level: 1, children: [{ type: "text", text: "Title#" }] });
    expect(heading("### ###")).toEqual({ level: 3, children: [] });
    expect(heading("#\tTabbed\t#\t")).toEqual({
      level: 1,
      children: [{ type: "text", text: "Tabbed" }],
    });
    expect(parseMarkdown("#hashtag")[0]!.type).toBe("paragraph");
    expect(parseMarkdown("####### seven")[0]!.type).toBe("paragraph");
  });

  test("keeps fence, rule, list, table, and inline recognition", () => {
    expect(parseMarkdown("~~~ js `x`\ncode\n~~~")[0]).toEqual({
      type: "code",
      language: "js",
      text: "code",
    });
    // A backtick fence's info string may not hold backticks; this is inline code instead.
    expect(parseMarkdown("``` a ` b")[0]!.type).toBe("paragraph");
    expect(parseMarkdown("* * *")[0]).toEqual({ type: "rule" });
    expect(parseMarkdown("1) one\n2) two")[0]).toMatchObject({ type: "list", ordered: true });
    expect(parseMarkdown("a | b\n:-: | --:\n1 | 2")[0]).toMatchObject({
      type: "table",
      align: ["center", "right"],
    });
    expect(parseMarkdown("a | b\n- | x")[0]!.type).toBe("paragraph");
    expect(parseMarkdownInline("``a`b``")).toEqual([{ type: "code", text: "a`b" }]);
    expect(parseMarkdownInline('[t](https://x.test/a_(b) "title")')).toEqual([
      { type: "link", href: "https://x.test/a_(b)", children: [{ type: "text", text: "t" }] },
    ]);
  });
});

describe("MarkdownPreview size limit", () => {
  /** Render the preview for one file whose source declares `byteLength`. */
  function renderPreviewTest(byteLength: number) {
    const reads: string[] = [];
    const context: PreviewContextValue = {
      resources: () => [
        {
          id: "source-new",
          generation: "g1",
          fileKey: "docs/big.md",
          kind: "source",
          contentType: REVIEW_SOURCE_CONTENT_TYPE,
          side: "new",
          sourceIdentity: "s1",
          byteLength,
          digest: "sha256:test",
        },
      ],
      read: async (descriptor) => {
        reads.push(descriptor.id);
        return new Uint8Array();
      },
      markdownModes: new MarkdownModeStore(),
    };
    const html = renderToStaticMarkup(
      <PreviewContext.Provider value={context}>
        <MarkdownPreview fileKey="docs/big.md" side="new" fallback={<p>the diff</p>} />
      </PreviewContext.Provider>,
    );
    return { html, reads };
  }

  test("shows the diff with a reason instead of parsing a source past the limit", () => {
    const { html, reads } = renderPreviewTest(MAX_MARKDOWN_PREVIEW_BYTES + 1);

    expect(html).toContain(markdownTooLargeMessage(MAX_MARKDOWN_PREVIEW_BYTES + 1));
    expect(html).toContain("Too large to render (512.0 KB; the limit is 512.0 KB)");
    expect(html).toContain("<p>the diff</p>");
    expect(html).not.toContain("markdown-preview");
    expect(reads).toEqual([]);
  });

  test("reads a source within the limit", () => {
    const { html } = renderPreviewTest(MAX_MARKDOWN_PREVIEW_BYTES);

    expect(html).toContain("Loading Markdown…");
    expect(html).not.toContain("the diff");
  });
});
