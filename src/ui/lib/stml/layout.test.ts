import { describe, expect, test } from "bun:test";
import { layoutStml, layoutStmlCached, type StmlLine } from "./layout";

function lineText(line: StmlLine): string {
  return line.spans.map((span) => span.text).join("");
}

function frameText(lines: StmlLine[]): string[] {
  return lines.map(lineText);
}

describe("layoutStml", () => {
  test("wraps plain text to the given width", () => {
    const { lines, errors } = layoutStml("one two three four five", 10);
    expect(errors).toHaveLength(0);
    expect(frameText(lines)).toEqual(["one two", "three four", "five"]);
  });

  test("is deterministic: same input, same lines", () => {
    const markup = '<card title="t"><list><item>alpha beta</item></list></card>';
    const a = layoutStml(markup, 30);
    const b = layoutStml(markup, 30);
    expect(a).toEqual(b);
  });

  test("carries inline styles through wrapping", () => {
    const { lines } = layoutStml("<b>bold and long words here</b>", 12);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      for (const span of line.spans) {
        expect(span.bold).toBe(true);
      }
    }
  });

  test("decodes entities in flowing text", () => {
    const { lines } = layoutStml("<text>a &rarr; b &amp; c</text>", 30);
    expect(lineText(lines[0]!)).toBe("a → b & c");
  });

  test("honors explicit <br> line breaks", () => {
    const { lines } = layoutStml("first<br>second", 40);
    expect(frameText(lines)).toEqual(["first", "second"]);
  });

  test("renders a bordered card with a title, filling the exact width", () => {
    const { lines } = layoutStml('<card title="Plan">hi</card>', 20);
    const rows = frameText(lines);
    expect(rows[0]).toContain("╭─ Plan ");
    expect(rows[rows.length - 1]).toBe(`╰${"─".repeat(18)}╯`);
    for (const row of rows) {
      expect(row.length).toBe(20);
    }
    // card = top border + padding row + content + padding row + bottom border
    expect(rows).toHaveLength(5);
  });

  test("box without border attribute stays frameless", () => {
    const { lines } = layoutStml("<box>hi</box>", 20);
    expect(frameText(lines)).toEqual(["hi" + " ".repeat(18)]);
  });

  test("double border style uses double glyphs", () => {
    const { lines } = layoutStml('<box border border-style="double">x</box>', 10);
    expect(lineText(lines[0]!)).toBe(`╔${"═".repeat(8)}╗`);
  });

  test("lays out row columns side by side with a gap", () => {
    const { lines } = layoutStml("<row><box border>aa</box><box border>bb</box></row>", 21);
    const rows = frameText(lines);
    expect(rows[0]).toBe(`┌${"─".repeat(8)}┐ ┌${"─".repeat(8)}┐`);
    expect(rows[1]).toContain("│aa");
    expect(rows[1]).toContain("│bb");
  });

  test("row honors fixed column widths", () => {
    const { lines } = layoutStml(
      '<row gap="1"><box border width="6">a</box><box border>b</box></row>',
      20,
    );
    const top = lineText(lines[0]!);
    expect(top.startsWith(`┌${"─".repeat(4)}┐ ┌`)).toBe(true);
    expect(top.length).toBe(20);
  });

  test("degrades a too-narrow row to stacked blocks with a note", () => {
    const { lines, errors } = layoutStml("<row>" + "<box border>x</box>".repeat(6) + "</row>", 9);
    expect(errors.some((error) => error.includes("too narrow"))).toBe(true);
    expect(lines.length).toBeGreaterThan(6);
  });

  test("renders ordered and unordered lists with hanging indents", () => {
    const { lines } = layoutStml(
      "<ol><item>first item that wraps around</item><item>second</item></ol>",
      16,
    );
    const rows = frameText(lines);
    expect(rows[0]!.startsWith("1. first")).toBe(true);
    expect(rows[1]!.startsWith("   ")).toBe(true);
    expect(rows[rows.length - 1]!.startsWith("2. second")).toBe(true);
  });

  test("keeps code blocks verbatim, clipped instead of wrapped", () => {
    const markup = `<code>
      const value = 1;
      const aVeryLongLineThatShouldClipInsteadOfWrappingAnywhereAtAll = true;
    </code>`;
    const { lines } = layoutStml(markup, 24);
    const rows = frameText(lines);
    expect(rows[1]).toContain("const value = 1;");
    // 2 border rows + 2 code lines, no soft wrap
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(24);
    }
  });

  test("hr fills the width", () => {
    const { lines } = layoutStml("<hr>", 12);
    expect(lineText(lines[0]!)).toBe("─".repeat(12));
  });

  test("headings are bold and h1 is underlined", () => {
    const { lines } = layoutStml("<h1>Title</h1><h2>Sub</h2>", 20);
    expect(lines[0]!.spans[0]).toMatchObject({ bold: true, underline: true, fg: "heading" });
    expect(lines[1]!.spans[0]).toMatchObject({ bold: true, fg: "heading" });
  });

  test("badges pad their label and default to accent background", () => {
    const { lines } = layoutStml("<badge>OK</badge>", 20);
    const spans = lines[0]!.spans;
    expect(lineText(lines[0]!)).toBe(" OK ");
    expect(spans.every((span) => span.bg === "accent")).toBe(true);
  });

  test("unknown tags degrade to their children plus an error note", () => {
    const { lines, errors } = layoutStml("<wat>content</wat>", 20);
    expect(frameText(lines)).toEqual(["content"]);
    expect(errors.some((error) => error.includes("unknown tag"))).toBe(true);
  });

  test("returns no lines below the minimum width", () => {
    const { lines, errors } = layoutStml("hello", 3);
    expect(lines).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("spacer emits blank rows", () => {
    const { lines } = layoutStml('a<spacer size="2"/>b', 10);
    expect(frameText(lines)).toEqual(["a", "", "", "b"]);
  });

  test("hard-slices a single word wider than the line", () => {
    const { lines } = layoutStml("abcdefghijklmnop", 8);
    expect(frameText(lines)).toEqual(["abcdefgh", "ijklmnop"]);
  });

  test("bg fills padded box rows", () => {
    const { lines } = layoutStml('<box bg="subtle" padding="1">x</box>', 12);
    for (const line of lines) {
      expect(lineText(line).length).toBe(12);
      for (const span of line.spans) {
        expect(span.bg).toBe("subtle");
      }
    }
  });

  test("cached layout returns stable results", () => {
    const markup = "<text>cache me</text>";
    expect(layoutStmlCached(markup, 20)).toBe(layoutStmlCached(markup, 20));
    expect(layoutStmlCached(markup, 20)).not.toBe(layoutStmlCached(markup, 24));
  });
});
