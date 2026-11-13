/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_INLINE_LINE_LENGTH,
  parseMarkdown,
  parseMarkdownInline,
  safeMarkdownHref,
} from "./markdown";
import { MarkdownView } from "./MarkdownView";

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
