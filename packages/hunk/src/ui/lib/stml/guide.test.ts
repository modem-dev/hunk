import { describe, expect, test } from "bun:test";
import { STML_GUIDE, stmlGuideSnippets } from "./guide";
import { layoutStml, STML_REFERENCE_WIDTH } from "./layout";

describe("STML guide", () => {
  test("contains a copy-paste snippet for every core mechanic", () => {
    const snippets = stmlGuideSnippets();
    expect(snippets.length).toBeGreaterThanOrEqual(8);

    // The idioms agents cannot derive from the tag list alone.
    expect(STML_GUIDE).toContain("█");
    expect(STML_GUIDE).toContain("&rarr;");
    expect(STML_GUIDE).toContain("--width");
    expect(STML_GUIDE).toContain("--experimental");
    expect(STML_GUIDE).toContain("experimentalFeatures");
    expect(STML_GUIDE).toContain(`${STML_REFERENCE_WIDTH}`);
  });

  test("teaches agents that STML composes inside Hunk's existing note frame", () => {
    expect(STML_GUIDE).toContain("Hunk supplies the note's outer frame");
    expect(STML_GUIDE).toContain("Sibling and nested boxes are supported");
    expect(STML_GUIDE).toContain("<box border");
  });

  test("presents snippets as mechanics rather than preferred layouts", () => {
    expect(STML_GUIDE).toContain("## Syntax examples");
    expect(STML_GUIDE).toContain("demonstrate mechanics, not preferred layouts");
    expect(STML_GUIDE).toContain("combine, omit, repeat, and nest");
    expect(STML_GUIDE).not.toContain("## Patterns");
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
