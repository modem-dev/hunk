import { describe, expect, test } from "bun:test";
import { cleanLastNewline, parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import type { DiffFile } from "../../../core/changeset/model";
import { loadHighlightedDiff, type HighlightedDiffCode } from "../diffRows";
import {
  COMPACT_HIGHLIGHT_FLAG_WORD_DIFF,
  COMPACT_HIGHLIGHT_PROTOCOL_VERSION,
  compactHighlightRunsForLine,
  compactHighlightTransferList,
  compactHighlightedDiffByteLength,
  encodeCompactHighlightedDiff,
  validateCompactHighlightedDiff,
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
