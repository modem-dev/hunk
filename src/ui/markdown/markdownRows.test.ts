import { describe, expect, it } from "bun:test";
import { renderMarkdownRows, wrapStyledSpans } from "./markdownRows";

describe("renderMarkdownRows", () => {
  it("renders a heading with depth", () => {
    const rows = renderMarkdownRows("# Title", 80);
    expect(rows[0]?.kind).toBe("heading");
    expect(rows[0]?.level).toBe(1);
    expect(rows[0]?.spans.map((s) => s.text).join("")).toBe("Title");
  });

  it("renders inline emphasis and code spans", () => {
    const rows = renderMarkdownRows("a **b** _c_ `d`", 80);
    const para = rows.find((r) => r.kind === "paragraph");
    const kinds = para?.spans.map((s) => `${s.kind}:${s.text}`);
    expect(kinds).toEqual(["text:a ", "strong:b", "text: ", "em:c", "text: ", "code:d"]);
  });

  it("renders bullet list items with nesting level", () => {
    const rows = renderMarkdownRows("- one\n- two\n  - nested", 80);
    const bullets = rows.filter((r) => r.kind === "bullet");
    expect(bullets).toHaveLength(3);
    expect(bullets[2]?.level).toBe(1);
    expect(bullets[0]?.spans.map((s) => s.text).join("")).toBe("one");
  });

  it("renders ordered list items with ordinals", () => {
    const rows = renderMarkdownRows("1. first\n2. second", 80);
    const ordered = rows.filter((r) => r.kind === "ordered");
    expect(ordered.map((r) => r.ordinal)).toEqual([1, 2]);
  });

  it("renders blockquotes, rules, and links", () => {
    const rows = renderMarkdownRows("> quoted\n\n---\n\n[text](https://x.dev)", 80);
    expect(rows.some((r) => r.kind === "quote")).toBe(true);
    expect(rows.some((r) => r.kind === "rule")).toBe(true);
    const linkSpan = rows.flatMap((r) => r.spans).find((s) => s.kind === "link");
    expect(linkSpan?.href).toBe("https://x.dev");
  });

  it("renders fenced code blocks as code rows carrying the language", () => {
    const rows = renderMarkdownRows("```ts\nconst a = 1;\nconst b = 2;\n```", 80);
    const code = rows.filter((r) => r.kind === "code");
    expect(code).toHaveLength(2);
    expect(code[0]?.language).toBe("ts");
    expect(code[0]?.spans.map((s) => s.text).join("")).toBe("const a = 1;");
  });

  it("emits a single logical paragraph row (wrapping happens at render time)", () => {
    const rows = renderMarkdownRows("aaa bbb ccc ddd", 7);
    const paras = rows.filter((r) => r.kind === "paragraph");
    expect(paras).toHaveLength(1);
    expect(paras[0]?.spans.map((s) => s.text).join("")).toBe("aaa bbb ccc ddd");
  });

  it("falls back to a paragraph for unsupported tokens (e.g. tables)", () => {
    const rows = renderMarkdownRows("| a | b |\n| - | - |\n| 1 | 2 |", 80);
    // No throw; everything degrades to readable paragraph or blank rows.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => ["paragraph", "blank"].includes(r.kind))).toBe(true);
  });
});

describe("wrapStyledSpans", () => {
  it("wraps to the given width without exceeding it", () => {
    const lines = wrapStyledSpans([{ text: "aaa bbb ccc ddd", kind: "text" }], 7);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.map((s) => s.text).join("").length).toBeLessThanOrEqual(7);
    }
  });

  it("preserves inline span kinds across wrapped lines", () => {
    // The leading bold word and a trailing code word must keep their kinds even
    // though the content wraps to multiple lines.
    const lines = wrapStyledSpans(
      [
        { text: "bold", kind: "strong" },
        { text: " word word word word word word ", kind: "text" },
        { text: "code", kind: "code" },
      ],
      10,
    );
    expect(lines.length).toBeGreaterThan(1);
    const all = lines.flat();
    expect(all.find((s) => s.text === "bold")?.kind).toBe("strong");
    expect(all.find((s) => s.text === "code")?.kind).toBe("code");
  });

  it("hard-breaks a word longer than the width", () => {
    const lines = wrapStyledSpans([{ text: "supercalifragilistic", kind: "text" }], 6);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.map((s) => s.text).join("").length).toBeLessThanOrEqual(6);
    }
    expect(
      lines
        .flat()
        .map((s) => s.text)
        .join(""),
    ).toBe("supercalifragilistic");
  });

  it("returns a single empty line for empty input", () => {
    expect(wrapStyledSpans([], 10)).toEqual([[{ text: "", kind: "text" }]]);
  });
});
