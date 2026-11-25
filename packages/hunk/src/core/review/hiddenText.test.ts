import { describe, expect, test } from "bun:test";
import {
  describeReviewHiddenCharacter,
  findReviewHiddenCharacters,
  formatReviewHiddenCharacter,
  mayContainReviewHiddenCharacters,
  revealReviewHiddenText,
  reviewFileHiddenText,
  reviewHiddenCharacterKind,
  splitReviewHiddenText,
} from "./hiddenText";

/** A file shape with only the fields hidden-text detection reads. */
function createTestHiddenTextFile(
  overrides: Partial<{
    path: string;
    previousPath: string;
    additionLines: string[];
    deletionLines: string[];
  }> = {},
) {
  return { path: "src/a.ts", additionLines: [], deletionLines: [], ...overrides };
}

describe("reviewHiddenCharacterKind", () => {
  test("classifies bidi controls and invisible characters", () => {
    for (const codePoint of [
      0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
      0x2069,
    ]) {
      expect(reviewHiddenCharacterKind(codePoint)).toBe("bidi");
    }
    for (const codePoint of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x3164, 0xe0041]) {
      expect(reviewHiddenCharacterKind(codePoint)).toBe("invisible");
    }
    for (const codePoint of [0x41, 0x20, 0x09, 0x05d0, 0x0627, 0xfe0f, 0x1f600]) {
      expect(reviewHiddenCharacterKind(codePoint)).toBeUndefined();
    }
  });

  test("keeps the fast pre-check in step with the classification", () => {
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const flagged = reviewHiddenCharacterKind(codePoint) !== undefined;
      if (mayContainReviewHiddenCharacters(String.fromCodePoint(codePoint)) !== flagged) {
        throw new Error(`pre-check disagrees at ${formatReviewHiddenCharacter(codePoint)}`);
      }
    }
  });
});

describe("findReviewHiddenCharacters", () => {
  test("finds every control of a Trojan Source line, in logical order", () => {
    const line = "/*\u202E } \u2066if (isAdmin)\u2069 \u2066 begin admins only */";
    expect(findReviewHiddenCharacters(line).map((character) => character.codePoint)).toEqual([
      0x202e, 0x2066, 0x2069, 0x2066,
    ]);
    expect(findReviewHiddenCharacters(line)[0]).toEqual({
      index: 2,
      length: 1,
      codePoint: 0x202e,
      kind: "bidi",
    });
  });

  test("leaves legitimate right-to-left text alone", () => {
    expect(findReviewHiddenCharacters('const greeting = "שלום עולם";')).toEqual([]);
    expect(findReviewHiddenCharacters("// مرحبا بالعالم")).toEqual([]);
    expect(revealReviewHiddenText("docs/שלום.md")).toBe("docs/שלום.md");
  });

  test("flags zero-width characters inside ASCII identifiers", () => {
    expect(findReviewHiddenCharacters("is\u200BAdmin").map((character) => character.index)).toEqual(
      [2],
    );
    expect(findReviewHiddenCharacters("a\u200Db")).toHaveLength(1);
    expect(findReviewHiddenCharacters("a\u200C")).toHaveLength(1);
  });

  test("keeps joiners that shape emoji and Persian text", () => {
    // Family emoji and rainbow flag (with a variation selector before the joiner).
    expect(findReviewHiddenCharacters("👨\u200D👩\u200D👧")).toEqual([]);
    expect(findReviewHiddenCharacters("🏳\uFE0F\u200D🌈")).toEqual([]);
    // Persian "می\u200Cخواهم" with a zero width non-joiner.
    expect(findReviewHiddenCharacters("می\u200Cخواهم")).toEqual([]);
  });

  test("keeps the tags of a subdivision flag and flags stray tags", () => {
    const england = "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
    expect(findReviewHiddenCharacters(england)).toEqual([]);
    const smuggled = "ok\u{E0069}\u{E0067}";
    expect(findReviewHiddenCharacters(smuggled)).toEqual([
      { index: 2, length: 2, codePoint: 0xe0069, kind: "invisible" },
      { index: 4, length: 2, codePoint: 0xe0067, kind: "invisible" },
    ]);
  });

  // Intent: note text reaches this scan on the page's main thread, so a long tag run must not
  // cost quadratic time (each tag once walked back over the whole run before it).
  test("scans a long tag run in linear time", () => {
    // 60,000 tags (240 KB, under the note limit): a few milliseconds when linear, and over a
    // billion backward steps — many seconds — when each tag rescans the run.
    const run = String.fromCodePoint(0xe0061).repeat(60_000);
    const started = performance.now();
    const found = findReviewHiddenCharacters(run);
    const elapsed = performance.now() - started;
    expect(found).toHaveLength(60_000);
    expect(elapsed).toBeLessThan(1_000);
    expect(findReviewHiddenCharacters(`\u{1F3F4}${run}`)).toEqual([]);
  });

  test("exempts only a leading byte-order mark, and only when asked", () => {
    expect(findReviewHiddenCharacters("\uFEFFimport x", { ignoreLeadingBom: true })).toEqual([]);
    expect(findReviewHiddenCharacters("\uFEFFimport x")).toHaveLength(1);
    expect(findReviewHiddenCharacters("a\uFEFFb", { ignoreLeadingBom: true })).toHaveLength(1);
  });
});

describe("splitReviewHiddenText", () => {
  test("splits a spoofed filename around its override", () => {
    const segments = splitReviewHiddenText("file\u202Etxt.exe");
    expect(segments.map((segment) => segment.text)).toEqual(["file", "\u202E", "txt.exe"]);
    expect(segments[1]!.hidden?.kind).toBe("bidi");
    expect(segments[0]!.hidden).toBeUndefined();
  });

  test("returns ordinary text as one segment and nothing for empty text", () => {
    expect(splitReviewHiddenText("plain")).toEqual([{ text: "plain" }]);
    expect(splitReviewHiddenText("")).toEqual([]);
  });
});

describe("revealReviewHiddenText", () => {
  test("names each flagged character with a visible marker", () => {
    expect(revealReviewHiddenText("file\u202Etxt.exe")).toBe("file<U+202E>txt.exe");
    expect(revealReviewHiddenText("a\u200Bb\u{E0041}")).toBe("a<U+200B>b<U+E0041>");
  });
});

describe("describeReviewHiddenCharacter", () => {
  test("names known characters and falls back to the kind", () => {
    expect(describeReviewHiddenCharacter({ codePoint: 0x202e, kind: "bidi" })).toBe(
      "right-to-left override (U+202E)",
    );
    expect(describeReviewHiddenCharacter({ codePoint: 0x2063, kind: "invisible" })).toBe(
      "invisible character (U+2063)",
    );
    expect(describeReviewHiddenCharacter({ codePoint: 0xe0041, kind: "invisible" })).toBe(
      "tag character (U+E0041)",
    );
  });
});

describe("reviewFileHiddenText", () => {
  test("reports nothing for an ordinary file, legitimate RTL text included", () => {
    expect(
      reviewFileHiddenText(
        createTestHiddenTextFile({ additionLines: ["\uFEFFconst a = 1;", "// שלום\n"] }),
      ),
    ).toBeUndefined();
  });

  test("reports bidi controls in content and invisible characters in a path", () => {
    expect(
      reviewFileHiddenText(createTestHiddenTextFile({ deletionLines: ["x /*\u202E*/"] })),
    ).toEqual({ bidi: true, invisible: false });
    expect(reviewFileHiddenText(createTestHiddenTextFile({ path: "src/a\u200B.ts" }))).toEqual({
      bidi: false,
      invisible: true,
    });
    expect(
      reviewFileHiddenText(
        createTestHiddenTextFile({ previousPath: "old\u202E.ts", additionLines: ["a\u2060b"] }),
      ),
    ).toEqual({ bidi: true, invisible: true });
  });
});
