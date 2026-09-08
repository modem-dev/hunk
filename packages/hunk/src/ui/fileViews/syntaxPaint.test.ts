import { describe, expect, test } from "bun:test";
import type { ExtensionFileViewSpan } from "../../extension-api/types";
import { THEMES } from "../themes";
import {
  createDocumentHighlightService,
  type DocumentHighlightResult,
  type DocumentHighlightRun,
} from "../diff/documentHighlightService";
import { preserveCrossSpanGraphemes } from "../diff/styledSpanLayout";
import type { CompactHighlightedDocument } from "../diff/worker";
import {
  createFileViewSyntaxProjector,
  projectFileViewSyntaxSpan,
  validateFileViewSyntaxLineProjection,
} from "./syntaxPaint";

const theme = THEMES.find((candidate) => candidate.id === "github-dark-default")!;

/** Wrap explicit line ranges in the service-owned highlighted-result abstraction. */
async function highlightedResult(
  text: string,
  runs: readonly DocumentHighlightRun[],
): Promise<DocumentHighlightResult> {
  const palette: string[] = [];
  const styleIds = runs.map((run) => {
    if (!run.fg) return 0;
    let index = palette.indexOf(run.fg);
    if (index < 0) {
      palette.push(run.fg);
      index = palette.length - 1;
    }
    return index + 1;
  });
  const compact: CompactHighlightedDocument = {
    version: 1,
    foregroundPalette: palette,
    document: {
      lineOffsets: Uint32Array.from([0, runs.length]),
      starts: Uint32Array.from(runs.map((run) => run.start)),
      ends: Uint32Array.from(runs.map((run) => run.end)),
      styleIds: Uint16Array.from(styleIds),
      flags: Uint8Array.from(runs.map(() => 0)),
    },
  };
  const service = createDocumentHighlightService({
    inlineHighlight: async () => compact,
  });
  return service.highlight({
    text,
    path: "projection.ts",
    language: "typescript",
    theme,
    offloadLargeDiff: false,
  });
}

/** Project one span against a single named highlighted document. */
async function project(
  span: ExtensionFileViewSpan,
  source: string,
  runs: readonly DocumentHighlightRun[],
) {
  const result = await highlightedResult(source, runs);
  return projectFileViewSyntaxSpan(span, new Map([["code", result]]));
}

describe("file-view syntax paint projection", () => {
  test("projects a complete line, keeps gaps, and coalesces adjacent colors", async () => {
    const projected = await project(
      { text: "abcdef", syntax: { documentId: "code", line: 1 } },
      "abcdef",
      [
        { start: 0, end: 2, fg: "#112233" },
        { start: 2, end: 4, fg: "#112233" },
        { start: 4, end: 6 },
      ],
    );

    expect(projected).toEqual([{ text: "abcd", fg: "#112233" }, { text: "ef" }]);
    expect(projected?.map((run) => run.text).join("")).toBe("abcdef");
  });

  test("clips document ranges and translates them to partial-span offsets", async () => {
    const projected = await project(
      {
        text: "bcdefg",
        syntax: { documentId: "code", line: 1, range: [1, 7] },
      },
      "abcdefgh",
      [
        { start: 0, end: 2, fg: "#111111" },
        { start: 2, end: 5, fg: "#222222" },
        { start: 5, end: 8 },
      ],
    );

    expect(projected).toEqual([
      { text: "b", fg: "#111111" },
      { text: "cde", fg: "#222222" },
      { text: "fg" },
    ]);
  });

  test("honors half-open boundaries at adjacent token runs", async () => {
    const runs = [
      { start: 0, end: 2, fg: "#111111" },
      { start: 2, end: 4, fg: "#222222" },
    ];
    expect(
      await project(
        { text: "ab", syntax: { documentId: "code", line: 1, range: [0, 2] } },
        "abcd",
        runs,
      ),
    ).toEqual([{ text: "ab", fg: "#111111" }]);
    expect(
      await project(
        { text: "cd", syntax: { documentId: "code", line: 1, range: [2, 4] } },
        "abcd",
        runs,
      ),
    ).toEqual([{ text: "cd", fg: "#222222" }]);
  });

  test("rejects malformed projected lines with overlaps or gaps", () => {
    expect(
      validateFileViewSyntaxLineProjection([
        { start: 0, end: 2 },
        { start: 1, end: 3 },
      ]),
    ).toBeNull();
    expect(
      validateFileViewSyntaxLineProjection([
        { start: 0, end: 1 },
        { start: 2, end: 3 },
      ]),
    ).toBeNull();
    expect(validateFileViewSyntaxLineProjection([{ start: 0, end: 0 }])).toBeNull();
  });

  test("keeps split-style references independent by document lookup", async () => {
    const [oldResult, newResult] = await Promise.all([
      highlightedResult("old", [{ start: 0, end: 3, fg: "#AA0000" }]),
      highlightedResult("new", [{ start: 0, end: 3, fg: "#00AA00" }]),
    ]);
    const highlights = new Map([
      ["old", oldResult],
      ["new", newResult],
    ]);

    expect(
      projectFileViewSyntaxSpan(
        { text: "old", syntax: { documentId: "old", line: 1 } },
        highlights,
      ),
    ).toEqual([{ text: "old", fg: "#AA0000" }]);
    expect(
      projectFileViewSyntaxSpan(
        { text: "new", syntax: { documentId: "new", line: 1 } },
        highlights,
      ),
    ).toEqual([{ text: "new", fg: "#00AA00" }]);
  });

  test("resolves tokenizer boundaries to complete surrogate and combining graphemes", async () => {
    const astral = await project(
      { text: "A😀B", syntax: { documentId: "code", line: 1 } },
      "A😀B",
      [
        { start: 0, end: 2, fg: "#111111" },
        { start: 2, end: 4, fg: "#222222" },
      ],
    );
    expect(preserveCrossSpanGraphemes([...(astral ?? [])])).toEqual([
      { text: "A😀", fg: "#111111" },
      { text: "B", fg: "#222222" },
    ]);

    const combining = await project({ text: "éx", syntax: { documentId: "code", line: 1 } }, "éx", [
      { start: 0, end: 1, fg: "#111111" },
      { start: 1, end: 3, fg: "#222222" },
    ]);
    expect(preserveCrossSpanGraphemes([...(combining ?? [])])).toEqual([
      { text: "é", fg: "#111111" },
      { text: "x", fg: "#222222" },
    ]);
  });

  test("preserves ZWJ emoji, tabs, and wide text exactly", async () => {
    const text = "\t👩‍💻界x";
    const emojiBoundary = text.indexOf("‍") + 1;
    const projected = await project({ text, syntax: { documentId: "code", line: 1 } }, text, [
      { start: 0, end: emojiBoundary, fg: "#111111" },
      { start: emojiBoundary, end: text.length, fg: "#222222" },
    ]);

    expect(projected?.map((run) => run.text).join("")).toBe(text);
    const graphemeSafe = preserveCrossSpanGraphemes([...(projected ?? [])]);
    expect(graphemeSafe.some((run) => run.text.includes("👩‍💻"))).toBe(true);
    expect(graphemeSafe.every((run) => !run.text.includes("\uFFFD"))).toBe(true);
  });

  test("projects a shared 999-run line once for 40,000 clipped spans", async () => {
    const source = "x".repeat(999);
    const result = await highlightedResult(
      source,
      Array.from({ length: 999 }, (_, index) => ({
        start: index,
        end: index + 1,
        fg: index % 2 === 0 ? "#111111" : "#222222",
      })),
    );
    const projector = createFileViewSyntaxProjector(new Map([["code", result]]));
    let projectedSpanCount = 0;
    for (let index = 0; index < 40_000; index += 1) {
      const start = index % source.length;
      if (
        projector.projectSpan({
          text: "x",
          syntax: { documentId: "code", line: 1, range: [start, start + 1] },
        })?.length === 1
      ) {
        projectedSpanCount += 1;
      }
    }
    expect(projectedSpanCount).toBe(40_000);
    expect(projector.projectedLineCount).toBe(1);
  });

  test("falls back for unavailable, stale, mismatched, or out-of-bounds projections", async () => {
    const span = {
      text: "abc",
      syntax: { documentId: "code", line: 1 as const },
    } satisfies ExtensionFileViewSpan;
    const highlighted = await highlightedResult("abc", [{ start: 0, end: 3, fg: "#112233" }]);

    expect(projectFileViewSyntaxSpan(span, new Map())).toBeNull();
    expect(
      projectFileViewSyntaxSpan(
        span,
        new Map([["code", { status: "highlighted", retryable: false } as const]]),
      ),
    ).toBeNull();
    expect(projectFileViewSyntaxSpan(span, new Map([["other", highlighted]]))).toBeNull();
    expect(
      projectFileViewSyntaxSpan(
        { ...span, syntax: { documentId: "code", line: 2 } },
        new Map([["code", highlighted]]),
      ),
    ).toBeNull();
    expect(
      projectFileViewSyntaxSpan({ ...span, text: "ab" }, new Map([["code", highlighted]])),
    ).toBeNull();
    expect(
      projectFileViewSyntaxSpan(
        {
          ...span,
          text: "bc",
          syntax: { documentId: "code", line: 1, range: [1, 4] },
        },
        new Map([["code", highlighted]]),
      ),
    ).toBeNull();
    expect(
      projectFileViewSyntaxSpan(
        { text: "", syntax: { documentId: "code", line: 1, range: [0, 0] } },
        new Map([["code", highlighted]]),
      ),
    ).toBeNull();
    expect(
      projectFileViewSyntaxSpan({ text: "plain" }, new Map([["code", highlighted]])),
    ).toBeNull();
    expect(
      projectFileViewSyntaxSpan(
        span,
        new Map([
          [
            "code",
            {
              status: "fallback",
              reason: "unsupported-language",
              retryable: false,
            } as const,
          ],
        ]),
      ),
    ).toBeNull();
  });
});
