import { describe, expect, test } from "bun:test";
import {
  reviewResourceId,
  semanticFileEntryIdentity,
  semanticFileIdentity,
  semanticFileMatchKeys,
  semanticFilesMatch,
} from "./identity";

describe("semantic review identity", () => {
  test("is stable across stream reorder and distinct across rename endpoints", () => {
    const input = {
      sourceIdentity: "repo:/work",
      path: "src/new.ts",
      previousPath: "src/old.ts",
    };

    expect(semanticFileIdentity(input)).toBe(semanticFileIdentity({ ...input }));
    expect(semanticFileIdentity(input)).not.toBe(
      semanticFileIdentity({ ...input, previousPath: "src/other.ts" }),
    );
    expect(semanticFileMatchKeys(input)).toEqual([
      "repo:/work\0src/new.ts",
      "repo:/work\0src/old.ts",
    ]);
    expect(
      semanticFilesMatch(input, {
        sourceIdentity: "repo:/work",
        path: "src/new.ts",
      }),
    ).toBe(true);
    expect(
      semanticFilesMatch(input, {
        sourceIdentity: "repo:/other",
        path: "src/new.ts",
      }),
    ).toBe(false);
  });

  test("keeps distinct repeated-path entries stable across reorder", () => {
    const common = {
      sourceIdentity: "repo:/work",
      path: "src/repeated.ts",
    };
    const first = semanticFileEntryIdentity({
      ...common,
      contentIdentity: reviewResourceId("content", "first", "patch"),
    });
    const second = semanticFileEntryIdentity({
      ...common,
      contentIdentity: reviewResourceId("content", "second", "patch"),
    });

    expect(first).not.toBe(second);
    expect(first).toBe(
      semanticFileEntryIdentity({
        ...common,
        contentIdentity: reviewResourceId("content", "first", "patch"),
      }),
    );
    expect(first).not.toBe(
      semanticFileEntryIdentity({
        ...common,
        contentIdentity: reviewResourceId("content", "first", "patch"),
        duplicateIndex: 1,
      }),
    );
  });

  test("addresses resources by generation, semantic file, kind and side", () => {
    const oldId = reviewResourceId("g1", "file:key", "source", "old");
    expect(oldId).toBe(reviewResourceId("g1", "file:key", "source", "old"));
    expect(oldId).not.toBe(reviewResourceId("g2", "file:key", "source", "old"));
    expect(oldId).not.toBe(reviewResourceId("g1", "file:key", "source", "new"));
  });
});
