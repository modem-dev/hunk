import { describe, expect, test } from "bun:test";
import { COMPARISONS, type Comparison } from "../website/src/data/comparisons";
import { renderComparisonMarkdown } from "../website/src/lib/comparisonMarkdown";
import { withInlineCode, withoutInlineCode } from "../website/src/lib/inlineCode";
import { toJsonLdScriptBody } from "../website/src/lib/jsonLd";

/**
 * The hunk.dev helpers that turn stored text into markup.
 *
 * Both are used with `set:html` or inside a raw `<script>` body, so a mistake
 * here is an injection rather than a typo. The catalogs they render are
 * hand-written today and will be generated later, which is exactly when nobody
 * is re-reading the escaping.
 */
describe("JSON-LD serialization", () => {
  test("neutralizes markup", () => {
    const body = toJsonLdScriptBody({ name: "</script><img src=x onerror=alert(1)>" });

    // Nothing can close the script element, and the payload is still JSON-LD.
    expect(body).not.toContain("<");
    expect(JSON.parse(body)).toEqual({ name: "</script><img src=x onerror=alert(1)>" });
  });
});

describe("inline code rendering", () => {
  test("promotes backtick spans to code elements", () => {
    expect(withInlineCode("Run `hunk diff` first.")).toBe("Run <code>hunk diff</code> first.");
    expect(withInlineCode("`a` then `b`")).toBe("<code>a</code> then <code>b</code>");
  });

  test("escapes markup before adding any of its own", () => {
    const rendered = withInlineCode('<img src=x onerror=alert(1)> & "quoted"');

    expect(rendered).not.toContain("<img");
    expect(rendered).toBe("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;");
  });

  test("cannot be tricked into emitting an element from inside a code span", () => {
    // The escape runs first, so a backtick span can only ever contain text.
    expect(withInlineCode("`<b>bold</b>`")).toBe("<code>&lt;b&gt;bold&lt;/b&gt;</code>");
  });

  test("leaves an unpaired backtick alone rather than opening an element", () => {
    expect(withInlineCode("a ` b")).toBe("a ` b");
  });

  test("strips backticks for contexts that take plain text", () => {
    expect(withoutInlineCode("Set `core.pager` to `hunk pager`.")).toBe(
      "Set core.pager to hunk pager.",
    );
  });
});

describe("comparison Markdown rendering", () => {
  /** A minimal entry, so each assertion below is about one property of the renderer. */
  function testComparison(overrides: Partial<Comparison> = {}): Comparison {
    return {
      slug: "hunk-vs-thing",
      rival: {
        name: "thing",
        kind: "a thing",
        url: "https://example.com/thing",
        language: "Rust",
        license: "MIT",
      },
      headline: "Hunk vs thing",
      title: "Hunk vs thing",
      description: "A description.",
      keywords: ["hunk vs thing"],
      summary: "A summary.",
      answer: "An answer.",
      pick: { hunk: ["Because."], rival: ["Because not."] },
      capabilities: [{ capability: "Does | things", hunk: "yes", rival: "no", note: "A | note" }],
      sections: [{ heading: "A heading", body: ["A paragraph."] }],
      faqs: [{ question: "Why?", answer: "Because." }],
      sources: [{ label: "Docs", url: "/docs/" }],
      ...overrides,
    };
  }

  test("escapes characters that would break out of a table cell", () => {
    const rendered = renderComparisonMarkdown(testComparison());

    // Both the capability and its note share one cell, so both need escaping.
    expect(rendered).toContain("| Does \\| things — A \\| note | Yes | No |");
  });

  test("neutralizes markup that reaches a cell", () => {
    const rendered = renderComparisonMarkdown(
      testComparison({
        capabilities: [{ capability: "<img src=x onerror=alert(1)>", hunk: "yes", rival: "no" }],
      }),
    );

    expect(rendered).not.toContain("<img");
    expect(rendered).toContain("&lt;img src=x onerror=alert(1)>");
  });

  test("absolutizes site-relative sources and leaves external ones alone", () => {
    const rendered = renderComparisonMarkdown(testComparison());

    expect(rendered).toContain("- [Docs](https://hunk.dev/docs/)");
    expect(
      renderComparisonMarkdown(
        testComparison({
          sources: [{ label: "Upstream", url: "https://example.com/thing" }],
        }),
      ),
    ).toContain("- [Upstream](https://example.com/thing)");
  });

  test("fences every code sample it renders", () => {
    const rendered = renderComparisonMarkdown(
      testComparison({
        sections: [
          { heading: "Setup", body: ["Do this."], code: { caption: "Run", lines: ["a | b"] } },
        ],
      }),
    );

    // An odd number of fences would leave the rest of the document inside a block.
    expect((rendered.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(rendered).toContain("Run:");
    expect(rendered).toContain("a | b");
  });

  test("renders every real comparison with a table and its own canonical URL", () => {
    for (const comparison of COMPARISONS) {
      const rendered = renderComparisonMarkdown(comparison);

      expect(rendered, comparison.slug).toStartWith(`# ${comparison.headline}\n`);
      expect(rendered, comparison.slug).toContain(`https://hunk.dev/compare/${comparison.slug}/`);
      // One header row plus a delimiter plus one row per capability.
      const rows = rendered.split("\n").filter((line) => line.startsWith("| "));
      expect(rows.length, comparison.slug).toBe(comparison.capabilities.length + 2);
    }
  });
});
