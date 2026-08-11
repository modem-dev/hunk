import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import {
  RANGELESS_NOTE_OWNERSHIP_POLICY,
  UNMATCHED_RANGED_NOTE_OWNERSHIP_POLICY,
  annotationAnchor,
  annotationIntersectingHunkIndices,
  annotationOwnerHunkIndex,
  annotationVisibleHunkIndices,
  getAnnotationIntersectingHunkIndices,
  getAnnotationOwnerHunkIndices,
  getAnnotationsVisibleInHunk,
  projectReviewNote,
  reviewNoteSource,
  stableReviewNoteId,
} from "./notes";

describe("renderer-neutral review notes", () => {
  test("classifies sources and prefers the new side of dual anchors", () => {
    expect(reviewNoteSource({ summary: "AI" })).toBe("ai");
    expect(reviewNoteSource({ summary: "Agent", source: "mcp" })).toBe("agent");
    expect(reviewNoteSource({ summary: "User", source: "user" })).toBe("user");
    expect(annotationAnchor({ summary: "Dual", oldRange: [2, 3], newRange: [5, 6] })).toEqual({
      side: "new",
      lineNumber: 5,
    });
  });

  test("owns dual-range notes through their preferred new-side anchor", () => {
    const file = createTestDiffFile({
      before: lines("old-one", "two", "three", "four", "old-five"),
      after: lines("new-one", "two", "three", "four", "new-five"),
      context: 0,
    });
    const annotation = {
      summary: "Dual",
      oldRange: [1, 1] as [number, number],
      newRange: [5, 5] as [number, number],
    };
    expect(annotationIntersectingHunkIndices(annotation, file.metadata.hunks)).toEqual([0, 1]);
    expect(annotationVisibleHunkIndices(annotation, file.metadata.hunks)).toEqual([0, 1]);
    expect(annotationOwnerHunkIndex(annotation, file.metadata.hunks)).toBe(1);

    const annotatedFile = {
      ...file,
      agent: { path: file.path, annotations: [annotation] },
    };
    expect([...getAnnotationOwnerHunkIndices(annotatedFile)]).toEqual([1]);
    expect([...getAnnotationIntersectingHunkIndices(annotatedFile)]).toEqual([0, 1]);
    expect(getAnnotationsVisibleInHunk(annotatedFile, file.metadata.hunks[0])).toEqual([
      annotation,
    ]);
    expect(getAnnotationsVisibleInHunk(annotatedFile, file.metadata.hunks[1])).toEqual([
      annotation,
    ]);

    const dto = projectReviewNote({
      annotation,
      fileKey: "file:key",
      hunks: file.metadata.hunks,
      origin: "sidecar",
    });
    expect(dto.anchor).toMatchObject({
      intersectingHunkIndices: [0, 1],
      ownerHunkIndex: 1,
    });
  });

  test("prefers a partially intersecting new range over an old-side hunk", () => {
    const file = createTestDiffFile({
      before: lines("old-one", "two", "three", "four", "old-five"),
      after: lines("new-one", "two", "three", "four", "new-five"),
      context: 0,
    });
    const annotation = {
      summary: "Dual partial overlap",
      oldRange: [1, 1] as [number, number],
      newRange: [4, 5] as [number, number],
    };

    expect(annotationIntersectingHunkIndices(annotation, file.metadata.hunks)).toEqual([0, 1]);
    expect(annotationOwnerHunkIndex(annotation, file.metadata.hunks)).toBe(1);
  });

  test("assigns range-less notes to the first hunk for rendering but not navigation", () => {
    const file = createTestDiffFile({ agent: true });
    const annotation = { summary: "Whole file" };
    const annotatedFile = {
      ...file,
      agent: { path: file.path, annotations: [annotation] },
    };

    expect(RANGELESS_NOTE_OWNERSHIP_POLICY).toBe("first-hunk");
    expect(annotationIntersectingHunkIndices(annotation, file.metadata.hunks)).toEqual([]);
    expect(annotationVisibleHunkIndices(annotation, file.metadata.hunks)).toEqual([0]);
    expect([...getAnnotationOwnerHunkIndices(annotatedFile)]).toEqual([0]);
    expect([...getAnnotationIntersectingHunkIndices(annotatedFile)]).toEqual([]);
    expect(getAnnotationsVisibleInHunk(annotatedFile, file.metadata.hunks[0])).toEqual([
      annotation,
    ]);

    const dto = projectReviewNote({
      annotation,
      fileKey: "file:key",
      hunks: file.metadata.hunks,
      origin: "sidecar",
    });
    expect(dto.anchor).toEqual({ intersectingHunkIndices: [], ownerHunkIndex: 0 });
  });

  test("keeps hunkless range-less notes at file scope", () => {
    const dto = projectReviewNote({
      annotation: { summary: "Hunkless" },
      fileKey: "file:key",
      hunks: [],
      origin: "sidecar",
    });

    expect(dto.anchor).toEqual({ intersectingHunkIndices: [] });
  });

  test("owns unmatched ranged notes through the named terminal fallback policy", () => {
    const file = createTestDiffFile();
    const annotation = { summary: "Outside", newRange: [500, 500] as [number, number] };

    const annotatedFile = {
      ...file,
      agent: { path: file.path, annotations: [annotation] },
    };

    expect(UNMATCHED_RANGED_NOTE_OWNERSHIP_POLICY).toBe("first-hunk-fallback");
    expect(annotationIntersectingHunkIndices(annotation, file.metadata.hunks)).toEqual([]);
    expect(annotationVisibleHunkIndices(annotation, file.metadata.hunks)).toEqual([0]);
    expect(annotationOwnerHunkIndex(annotation, file.metadata.hunks)).toBe(0);
    expect([...getAnnotationOwnerHunkIndices(annotatedFile)]).toEqual([0]);
    expect([...getAnnotationIntersectingHunkIndices(annotatedFile)]).toEqual([]);
    expect(getAnnotationsVisibleInHunk(annotatedFile, file.metadata.hunks[0])).toEqual([
      annotation,
    ]);
    expect(
      projectReviewNote({
        annotation,
        fileKey: "file:key",
        hunks: file.metadata.hunks,
        origin: "sidecar",
      }).anchor,
    ).toEqual({
      newRange: [500, 500],
      preferred: { side: "new", line: 500 },
      intersectingHunkIndices: [],
      ownerHunkIndex: 0,
    });
  });

  test("keeps generated and explicit ids stable until a collision is disambiguated", () => {
    const annotation = { summary: "Stable", newRange: [3, 3] as [number, number] };
    const id = stableReviewNoteId(annotation, "file:key", "sidecar");
    expect(id).toBe(stableReviewNoteId(annotation, "file:key", "sidecar"));
    expect(stableReviewNoteId(annotation, "file:key", "sidecar", 1)).toBe(`${id}:1`);
    expect(stableReviewNoteId({ id: "explicit", summary: "Stable" }, "file:key", "sidecar")).toBe(
      "explicit",
    );
    expect(
      stableReviewNoteId({ id: "explicit", summary: "Stable" }, "file:key", "sidecar", 1),
    ).toBe("explicit:1");
  });

  test("projects complete text/STML metadata without loss", () => {
    const file = createTestDiffFile();
    const dto = projectReviewNote({
      annotation: {
        id: "note-1",
        source: "agent",
        oldRange: [1, 2],
        newRange: [1, 3],
        summary: "Summary",
        rationale: "Rationale",
        markup: "<p>Markup</p>",
        title: "Title",
        author: "Pi",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        tags: ["risk"],
        confidence: "medium",
      },
      fileKey: "file:key",
      hunks: file.metadata.hunks,
      origin: "live-agent",
    });

    expect(dto).toMatchObject({
      id: "note-1",
      source: "agent",
      origin: "live-agent",
      originalSource: "agent",
      summary: "Summary",
      rationale: "Rationale",
      markup: "<p>Markup</p>",
      title: "Title",
      author: "Pi",
      tags: ["risk"],
      confidence: "medium",
      editable: false,
    });
  });
});
