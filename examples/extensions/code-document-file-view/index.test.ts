import { describe, expect, test } from "bun:test";
import type { ExtensionFileViewInput } from "hunkdiff/extension";
import { validateFileViewLayout } from "../../../packages/hunk/src/ui/fileViews/layout";
import { createCodeDocumentLayout } from "./index";

/** Build a minimal public file-view input for the example's pure layout function. */
function createTestInput(oldText: string | null, newText: string | null): ExtensionFileViewInput {
  return {
    file: {
      id: "example.ts",
      path: "example.ts",
      patch: "",
      language: "typescript",
      stats: { additions: 1, deletions: 1 },
      metadata: {},
      hunks: [
        {
          index: 0,
          header: "@@ -1,1 +1,1 @@",
          oldRange: [1, 1],
          newRange: [1, 1],
        },
      ],
      agent: null,
    },
    width: 80,
    signal: new AbortController().signal,
    changes: [
      { hunkIndex: 0, kind: "removed", range: [1, 1] },
      { hunkIndex: 0, kind: "added", range: [1, 1] },
    ],
    readDocument: async (side) => (side === "old" ? oldText : newText),
  };
}

describe("code-document file-view example", () => {
  test("declares complete old/new documents and independent full/partial references", async () => {
    const layout = await createCodeDocumentLayout(
      createTestInput("const oldValue = 1;\n", "  const newValue = 2;\n"),
    );

    expect(layout?.codeDocuments).toEqual([
      { id: "old", text: "const oldValue = 1;\n" },
      { id: "new", text: "  const newValue = 2;\n" },
    ]);
    expect(layout?.rows[0]?.spans).toEqual([
      { text: "OLD 1 │ ", tone: "muted" },
      { text: "const oldValue = 1;", syntax: { documentId: "old", line: 1 } },
      { text: "   NEW 1 │ ", tone: "muted" },
      { text: "  ", tone: "muted" },
      {
        text: "const newValue = 2;",
        syntax: { documentId: "new", line: 1, range: [2, 21] },
      },
    ]);
    expect(layout?.hunkRows).toEqual([{ startRow: 0, endRow: 0 }]);
    expect(validateFileViewLayout(layout, 1, 80)).toMatchObject({
      valid: true,
    });
  });

  test("declines control-bearing documents rather than guessing sanitized offsets", async () => {
    expect(
      await createCodeDocumentLayout(createTestInput("const x = 1;", "\u001b[31mred")),
    ).toBeNull();
  });
});
