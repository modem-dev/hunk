/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HIDDEN_CHARACTER_SHADOW_CSS, RevealedText } from "./RevealedText";

describe("RevealedText", () => {
  test("isolates ordinary text without markers", () => {
    expect(renderToStaticMarkup(<RevealedText text="src/a.ts" />)).toBe(
      '<span class="revealed-text">src/a.ts</span>',
    );
    expect(renderToStaticMarkup(<RevealedText text="docs/שלום.md" />)).toBe(
      '<span class="revealed-text">docs/שלום.md</span>',
    );
  });

  // Intent: the marker keeps the real character, so a copy is exact, but hides it from
  // assistive technology and shows its code point instead.
  test("wraps each hidden character in a marker that keeps it", () => {
    expect(renderToStaticMarkup(<RevealedText text={"file\u202Etxt.exe"} />)).toBe(
      '<span class="revealed-text">file' +
        '<span class="hidden-char" data-kind="bidi" data-label="U+202E"' +
        ' title="right-to-left override (U+202E)">' +
        '<span class="hidden-char-source" aria-hidden="true">\u202E</span></span>' +
        "txt.exe</span>",
    );
  });

  test("leaves prose unisolated when asked", () => {
    const markup = renderToStaticMarkup(<RevealedText text={"a\u200Bb"} isolate={false} />);
    expect(markup.startsWith('a<span class="hidden-char" data-kind="invisible"')).toBe(true);
    expect(markup).not.toContain("revealed-text");
  });
});

describe("HIDDEN_CHARACTER_SHADOW_CSS", () => {
  test("makes markers atomic so their controls cannot reorder neighbors", () => {
    expect(HIDDEN_CHARACTER_SHADOW_CSS).toMatch(/\.hidden-char \{[^}]*display: inline-block;/);
    expect(HIDDEN_CHARACTER_SHADOW_CSS).toContain("content: attr(data-label);");
  });
});
