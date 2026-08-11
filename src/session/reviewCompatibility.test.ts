import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import { projectReviewDocument } from "../core/review/document";
import { projectReviewCompatibility } from "./reviewCompatibility";

describe("review compatibility projection", () => {
  test("preserves static-then-mutable file order while reusing immutable summaries", () => {
    const file = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      agent: {
        path: "alpha.ts",
        annotations: [{ newRange: [1, 1], summary: "static note" }],
      },
    });
    const projection = projectReviewDocument(
      { id: "compatibility", sourceLabel: "test", title: "test", files: [file] },
      { generation: "generation:test" },
    );
    const semanticFile = projection.document.files[0]!;
    const mutableNote = {
      ...semanticFile.notes[0]!,
      id: "mutable-note",
      origin: "user" as const,
      source: "user" as const,
      summary: "mutable note",
      editable: true,
    };

    const first = projectReviewCompatibility(projection.document.files, [mutableNote]);
    const second = projectReviewCompatibility(projection.document.files, [mutableNote]);

    expect(first.reviewNotes.map((note) => note.body)).toEqual(["static note", "mutable note"]);
    expect(second.reviewNotes[0]).toBe(first.reviewNotes[0]);
    expect(second.reviewNotes[1]).not.toBe(first.reviewNotes[1]);
  });
});
