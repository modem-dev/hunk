import { describe, expect, test } from "bun:test";
import { STML_GUIDE, stmlGuideSnippets } from "./guide";
import { layoutStml, STML_REFERENCE_WIDTH } from "./layout";

describe("STML guide", () => {
  test("contains a copy-paste snippet for every core pattern", () => {
    const snippets = stmlGuideSnippets();
    expect(snippets.length).toBeGreaterThanOrEqual(8);

    // The idioms agents cannot derive from the tag list alone.
    expect(STML_GUIDE).toContain("█");
    expect(STML_GUIDE).toContain("&rarr;");
    expect(STML_GUIDE).toContain("--width");
    expect(STML_GUIDE).toContain(`${STML_REFERENCE_WIDTH}`);
  });

  test("every snippet lays out cleanly at the reference width", () => {
    for (const snippet of stmlGuideSnippets()) {
      const { lines, errors } = layoutStml(snippet, STML_REFERENCE_WIDTH);
      expect(errors).toEqual([]);
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  test("snippets stay within the reference width", () => {
    for (const snippet of stmlGuideSnippets()) {
      const { lines } = layoutStml(snippet, STML_REFERENCE_WIDTH);
      for (const line of lines) {
        const text = line.spans.map((span) => span.text).join("");
        expect(text.length).toBeLessThanOrEqual(STML_REFERENCE_WIDTH);
      }
    }
  });
});
