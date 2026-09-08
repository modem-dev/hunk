import { describe, expect, test } from "bun:test";
import { cleanLastNewline, parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import type { DiffFile } from "../../../core/changeset/model";
import { loadHighlightedDiff, type HighlightedDiffCode } from "../diffRows";
import {
  COMPACT_HIGHLIGHT_FLAG_WORD_DIFF,
  COMPACT_HIGHLIGHT_PROTOCOL_VERSION,
  cloneCompactHighlightedDocument,
  compactHighlightRunsForLine,
  compactHighlightTransferList,
  compactHighlightedDiffByteLength,
  compactHighlightedDocumentByteLength,
  compactHighlightedDocumentRunsForLine,
  compactHighlightedDocumentTransferList,
  encodeCompactHighlightedDiff,
  encodeCompactHighlightedDocument,
  validateCompactHighlightedDiff,
  validateCompactHighlightedDocument,
} from "./highlightCompact";
import { collectHastHighlightRuns, type HastNode } from "./highlightHast";
import { resolveTheme } from "../../themes";
import { createTestSourceFetcher } from "../../../../../../test/helpers/diff-helpers";

/** Build a regular changed file with tabs and word-diff emphasis. */
function createDiffFile(): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: "example.ts",
      contents: "export const\tanswer = 41;\nexport const stable = true;\n",
      cacheKey: "compact-before",
    },
    {
      name: "example.ts",
      contents:
        "export const\tanswer = 42;\nexport const stable = true;\nexport const added = true;\n",
      cacheKey: "compact-after",
    },
    { context: 3 },
    true,
  );

  return {
    id: "compact-example",
    path: "example.ts",
    patch: "",
    language: "typescript",
    stats: { additions: 2, deletions: 1 },
    metadata,
    agent: null,
  };
}

const ELIXIR_BEFORE = `defmodule Repro do
  @doc """
  Line one.
  Line two.
  """
  def hello do
    :world
  end
end
`;
const ELIXIR_AFTER = ELIXIR_BEFORE.replace("Line two.", "Line two, edited.");
const ELIXIR_PATCH = `diff --git a/repro.ex b/repro.ex
--- a/repro.ex
+++ b/repro.ex
@@ -2,8 +2,8 @@
   @doc """
   Line one.
-  Line two.
+  Line two, edited.
   """
   def hello do
     :world
   end
 end
`;

/** Build a partial source-backed diff whose two sides require independent lexical state. */
function createSourceBackedDiff(): DiffFile {
  const metadata = parsePatchFiles(ELIXIR_PATCH, "compact-source", true)[0]?.files[0];
  if (!metadata) {
    throw new Error("Expected partial Elixir metadata");
  }

  return {
    id: "compact-source",
    path: "repro.ex",
    patch: ELIXIR_PATCH,
    language: "elixir",
    stats: { additions: 1, deletions: 1 },
    metadata,
    agent: null,
    sourceFetcher: createTestSourceFetcher((side) =>
      side === "old" ? ELIXIR_BEFORE : ELIXIR_AFTER,
    ),
  };
}

/** Build source lengths from the exact newline projection terminal rendering uses. */
function lineLengths(lines: string[]) {
  return lines.map((line) => cleanLastNewline(line).length);
}

/** Project HAST through the compact payload so assertions exercise no token-text response. */
function expectedCompactRuns(
  code: HighlightedDiffCode,
  appearance: "dark" | "light",
  side: "deletion" | "addition",
) {
  const lines = side === "deletion" ? code.deletionLines : code.additionLines;
  const palette = new Map<string, number>();
  for (const line of [...code.deletionLines, ...code.additionLines]) {
    for (const run of collectHastHighlightRuns(line, appearance)) {
      if (run.fg && !palette.has(run.fg)) {
        palette.set(run.fg, palette.size + 1);
      }
    }
  }

  return lines.map((line) => {
    let column = 0;
    return collectHastHighlightRuns(line, appearance).flatMap((run) => {
      const start = column;
      column += run.text.length;
      if (start === column) {
        return [];
      }
      return [
        {
          start,
          end: column,
          fg: run.fg,
          wordDiff: run.wordDiff,
        },
      ];
    });
  });
}

describe("compact highlighted document payload", () => {
  test("encodes empty, skipped, final-newline, and astral lines as text-free UTF-16 ranges", () => {
    const lines: Array<HastNode | undefined> = [
      { type: "text", value: "\n" },
      {
        type: "element",
        tagName: "span",
        properties: { style: "color:#syntax" },
        children: [{ type: "text", value: "a🙂b\n" }],
      },
      undefined,
      { type: "text", value: "tail\n" },
    ];

    const payload = encodeCompactHighlightedDocument(lines, "dark");
    validateCompactHighlightedDocument(payload, [0, 4, 7, 4]);

    expect(payload.foregroundPalette).toEqual(["#syntax"]);
    expect(payload.document.lineOffsets).toEqual(Uint32Array.from([0, 0, 1, 1, 2]));
    expect(compactHighlightedDocumentRunsForLine(payload, 0)).toEqual([]);
    expect(compactHighlightedDocumentRunsForLine(payload, 1)).toEqual([
      { start: 0, end: 4, fg: "#syntax", wordDiff: false },
    ]);
    expect(compactHighlightedDocumentRunsForLine(payload, 2)).toEqual([]);
    expect(compactHighlightedDocumentRunsForLine(payload, 3)).toEqual([
      { start: 0, end: 4, fg: undefined, wordDiff: false },
    ]);
    expect(JSON.stringify(payload)).not.toContain("a🙂b");
    expect(compactHighlightedDocumentByteLength(payload)).toBeGreaterThan(0);
  });

  test("clones cache ownership independently from a transferred document", () => {
    const payload = encodeCompactHighlightedDocument([{ type: "text", value: "cached\n" }], "dark");
    const cached = cloneCompactHighlightedDocument(payload);
    const transferred = structuredClone(payload, {
      transfer: compactHighlightedDocumentTransferList(payload),
    });

    expect(payload.document.starts.byteLength).toBe(0);
    validateCompactHighlightedDocument(cached, [6]);
    validateCompactHighlightedDocument(transferred, [6]);
    expect(compactHighlightedDocumentRunsForLine(cached, 0)).toEqual([
      { start: 0, end: 6, fg: undefined, wordDiff: false },
    ]);
    expect(cached.document.starts).not.toBe(transferred.document.starts);
  });

  test("rejects invalid document shapes, offsets, palettes, flags, and coverage", () => {
    const createPayload = () =>
      encodeCompactHighlightedDocument(
        [
          {
            type: "element",
            tagName: "span",
            properties: { style: "color:#syntax" },
            children: [{ type: "text", value: "code\n" }],
          },
        ],
        "dark",
      );

    const invalidShape = createPayload();
    invalidShape.document.starts = new Uint16Array([0]) as unknown as Uint32Array;
    expect(() => validateCompactHighlightedDocument(invalidShape, [4])).toThrow("typed arrays");

    const invalidInitialOffset = createPayload();
    invalidInitialOffset.document.lineOffsets[0] = 1;
    expect(() => validateCompactHighlightedDocument(invalidInitialOffset, [4])).toThrow(
      "must start at zero",
    );

    const invalidFinalOffset = createPayload();
    invalidFinalOffset.document.lineOffsets[1] = 0;
    expect(() => validateCompactHighlightedDocument(invalidFinalOffset, [4])).toThrow(
      "final offset",
    );

    const invalidPalette = createPayload();
    invalidPalette.document.styleIds[0] = 2;
    expect(() => validateCompactHighlightedDocument(invalidPalette, [4])).toThrow(
      "outside its palette",
    );

    const invalidFlag = createPayload();
    invalidFlag.document.flags[0] = 2;
    expect(() => validateCompactHighlightedDocument(invalidFlag, [4])).toThrow("unsupported flags");

    const invalidStart = createPayload();
    invalidStart.document.starts[0] = 1;
    expect(() => validateCompactHighlightedDocument(invalidStart, [4])).toThrow(
      "ranges are invalid",
    );

    const invalidCoverage = createPayload();
    invalidCoverage.document.ends[0] = 3;
    expect(() => validateCompactHighlightedDocument(invalidCoverage, [4])).toThrow("do not cover");

    const invalidLineCount = createPayload();
    expect(() => validateCompactHighlightedDocument(invalidLineCount, [])).toThrow(
      "line count does not match",
    );
  });

  test("rejects out-of-range document line projection", () => {
    const payload = encodeCompactHighlightedDocument([], "dark");
    validateCompactHighlightedDocument(payload, []);
    expect(() => compactHighlightedDocumentRunsForLine(payload, 0)).toThrow(
      "line index is outside",
    );
  });
});

describe("compact worker highlight payload", () => {
  test("preserves nested syntax inheritance and semantic word-diff emphasis without text", () => {
    const nestedLine: HastNode = {
      type: "element",
      tagName: "span",
      properties: { style: "color:#base" },
      children: [
        { type: "text", value: "const " },
        {
          type: "element",
          tagName: "span",
          properties: {
            style: "--diffs-token-dark:#keyword;--diffs-token-light:#light-keyword",
            "data-diff-span": "changed",
          },
          children: [{ type: "text", value: "answer" }],
        },
        { type: "text", value: "\n" },
      ],
    };
    const code: HighlightedDiffCode = {
      deletionLines: [nestedLine],
      additionLines: [],
    };

    const payload = encodeCompactHighlightedDiff(code, "dark");
    validateCompactHighlightedDiff(payload, { deletion: [12], addition: [] });

    expect(payload.foregroundPalette).toEqual(["#base", "#keyword"]);
    expect(compactHighlightRunsForLine(payload, "deletion", 0)).toEqual([
      { start: 0, end: 6, fg: "#base", wordDiff: false },
      { start: 6, end: 12, fg: "#keyword", wordDiff: true },
    ]);
    expect(payload.deletion.flags).toEqual(Uint8Array.from([0, COMPACT_HIGHLIGHT_FLAG_WORD_DIFF]));
  });

  test("round-trips actual Pierre output without HAST or token text", async () => {
    const file = createDiffFile();
    const theme = resolveTheme("github-dark-default", null);
    const highlighted = await loadHighlightedDiff(file, theme);
    const payload = encodeCompactHighlightedDiff(highlighted, theme.appearance);

    validateCompactHighlightedDiff(payload, {
      deletion: lineLengths(file.metadata.deletionLines),
      addition: lineLengths(file.metadata.additionLines),
    });
    expect(payload.version).toBe(COMPACT_HIGHLIGHT_PROTOCOL_VERSION);
    expect(JSON.stringify(payload)).not.toContain("export const");
    expect(compactHighlightedDiffByteLength(payload)).toBeGreaterThan(0);

    for (const side of ["deletion", "addition"] as const) {
      const expected = expectedCompactRuns(highlighted, theme.appearance, side);
      expect(expected).toHaveLength(
        side === "deletion"
          ? file.metadata.deletionLines.length
          : file.metadata.additionLines.length,
      );
      expect(
        expected.map((_, lineIndex) => compactHighlightRunsForLine(payload, side, lineIndex)),
      ).toEqual(expected);
    }
  });

  test("keeps source-backed old and new lines as independent compact sides", async () => {
    const file = createSourceBackedDiff();
    const theme = resolveTheme("github-dark-default", null);
    const highlighted = await loadHighlightedDiff(file, theme);
    const payload = encodeCompactHighlightedDiff(highlighted, theme.appearance);

    validateCompactHighlightedDiff(payload, {
      deletion: lineLengths(file.metadata.deletionLines),
      addition: lineLengths(file.metadata.additionLines),
    });
    expect(payload.deletion.lineOffsets).not.toBe(payload.addition.lineOffsets);
    for (const side of ["deletion", "addition"] as const) {
      const expected = expectedCompactRuns(highlighted, theme.appearance, side);
      expect(
        expected.map((_, lineIndex) => compactHighlightRunsForLine(payload, side, lineIndex)),
      ).toEqual(expected);
    }
  });

  test("rejects malformed ranges and survives a transferable clone", () => {
    const code: HighlightedDiffCode = {
      deletionLines: [{ type: "text", value: "answer\n" }],
      additionLines: [],
    };
    const payload = encodeCompactHighlightedDiff(code, "dark");
    const cloned = structuredClone(payload, { transfer: compactHighlightTransferList(payload) });

    validateCompactHighlightedDiff(cloned, { deletion: [6], addition: [] });
    expect(cloned.deletion.starts).toEqual(Uint32Array.from([0]));
    expect(payload.deletion.starts.byteLength).toBe(0);

    cloned.deletion.starts[0] = 1;
    expect(() => validateCompactHighlightedDiff(cloned, { deletion: [6], addition: [] })).toThrow(
      "ranges are invalid",
    );

    cloned.deletion.starts[0] = 0;
    cloned.deletion.ends[0] = 7;
    expect(() => validateCompactHighlightedDiff(cloned, { deletion: [6], addition: [] })).toThrow(
      "ranges are invalid",
    );
  });
});
