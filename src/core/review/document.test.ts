import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../test/helpers/diff-helpers";
import { createTestReviewParityFixture } from "../../../test/helpers/review-content-helpers";
import { buildReviewContentManifest } from "./contentManifest";
import { projectReviewDocument } from "./document";
import { reviewDigest } from "./identity";
import type { ReviewDocumentProjectionV1 } from "./types";

describe("review document projection", () => {
  test("is JSON-safe, ordered and lossless across serialization", () => {
    const fixture = createTestReviewParityFixture();
    const projection = projectReviewDocument(fixture.changeset, fixture.projectionOptions);
    const serialized = JSON.stringify(projection);
    const roundTripped = JSON.parse(serialized) as ReviewDocumentProjectionV1;

    expect(roundTripped.document.version).toBe(1);
    expect(roundTripped.document.files.map((file) => file.path)).toEqual(
      fixture.changeset.files.map((file) => file.path),
    );
    expect(roundTripped.document.files.every((file) => !("sourceFetcher" in file))).toBe(true);
    for (const [index, file] of projection.document.files.entries()) {
      const runtimeFile = fixture.changeset.files[index]!;
      expect(file.additionLines).toEqual(runtimeFile.metadata.additionLines);
      expect(file.deletionLines).toEqual(runtimeFile.metadata.deletionLines);
      expect(file.additionLines).not.toBe(runtimeFile.metadata.additionLines);
      expect(file.deletionLines).not.toBe(runtimeFile.metadata.deletionLines);
    }
    expect(buildReviewContentManifest(roundTripped)).toEqual(
      buildReviewContentManifest(projection),
    );
  });

  test("isolates lazy canonical content from extension-owned normalized arrays", () => {
    const source = createTestDiffFile({ before: "one\n", after: "two\n" });
    const projection = projectReviewDocument(
      { id: "isolated", title: "isolated", sourceLabel: "repo", files: [source] },
      { generation: "generation:isolated" },
    );
    const canonical = projection.document.files[0]!;
    const originalAddition = canonical.additionLines[0];
    const originalDeletion = canonical.deletionLines[0];

    source.metadata.additionLines[0] = "extension mutation";
    source.metadata.deletionLines[0] = "extension mutation";

    expect(canonical.additionLines[0]).toBe(originalAddition);
    expect(canonical.deletionLines[0]).toBe(originalDeletion);
  });

  test("keeps exact patches in generation-addressed resources", () => {
    const fixture = createTestReviewParityFixture();
    const { document, resourceContents } = projectReviewDocument(
      fixture.changeset,
      fixture.projectionOptions,
    );

    for (const [index, file] of document.files.entries()) {
      const descriptor = document.resources.find(
        (resource) => resource.id === file.patchResourceId,
      );
      expect(descriptor).toMatchObject({
        kind: "patch",
        generation: "generation:test-v1",
        fileKey: file.key,
      });
      expect(resourceContents[file.patchResourceId]).toBe(fixture.changeset.files[index]?.patch);
      const canonical = document.resources.find(
        (resource) => resource.id === file.canonicalResourceId,
      );
      expect(canonical).toEqual({
        id: file.canonicalResourceId,
        kind: "canonical-file",
        generation: "generation:test-v1",
        fileKey: file.key,
        contentType: "application/vnd.hunk.review-file+json; charset=utf-8",
      });
      expect(resourceContents[file.canonicalResourceId]).toBeUndefined();
    }

    const moved = document.files.find((file) => file.path === "src/moved.ts")!;
    const source = document.resources.find(
      (resource) => resource.id === moved.sourceResourceIds.new,
    );
    expect(source).toMatchObject({
      kind: "source",
      generation: "generation:test-v1",
      side: "new",
      byteLength: 17,
    });
  });

  test("distinguishes semantic file content even when normalized patches match", () => {
    const first = createTestDiffFile({ path: "same.ts", before: "one\n", after: "two\n" });
    const second = createTestDiffFile({ path: "same.ts", before: "one\n", after: "three\n" });
    first.patch = "";
    second.patch = "";

    const firstKey = projectReviewDocument(
      { id: "first", title: "first", sourceLabel: "repo", files: [first] },
      { sourceIdentity: "repo:stable" },
    ).document.files[0]!.key;
    const secondKey = projectReviewDocument(
      { id: "second", title: "second", sourceLabel: "repo", files: [second] },
      { sourceIdentity: "repo:stable" },
    ).document.files[0]!.key;

    expect(secondKey).not.toBe(firstKey);
  });

  test("keeps repeated paths as distinct stable entries with exact resources", () => {
    const firstPatch = "diff --git a/same.ts b/same.ts\n@@ -1 +1 @@\n-first\n+second\n";
    const secondPatch = "diff --git a/same.ts b/same.ts\n@@ -1 +1 @@\n-second\n+third\n";
    const firstFile = {
      ...createTestDiffFile({
        id: "commit-a",
        path: "same.ts",
        previousPath: "same.ts",
        before: "first\n",
        after: "second\n",
      }),
      patch: firstPatch,
    };
    const secondFile = {
      ...createTestDiffFile({
        id: "commit-b",
        path: "same.ts",
        previousPath: "same.ts",
        before: "second\n",
        after: "third\n",
      }),
      patch: secondPatch,
    };
    const changeset = {
      id: "flattened-stream",
      sourceLabel: "repo:test",
      title: "Two commits",
      files: [firstFile, secondFile],
    };

    const projection = projectReviewDocument(changeset, {
      generation: "generation:duplicate",
      sourceIdentity: "test:flattened-stream",
    });
    expect(projection.document.files.map((file) => file.path)).toEqual(["same.ts", "same.ts"]);
    expect(new Set(projection.document.files.map((file) => file.key)).size).toBe(2);
    expect(new Set(projection.document.files.map((file) => file.patchResourceId)).size).toBe(2);
    expect(
      projection.document.files.map((file) => projection.resourceContents[file.patchResourceId]),
    ).toEqual([firstPatch, secondPatch]);

    for (const [index, file] of projection.document.files.entries()) {
      const patch = changeset.files[index]!.patch;
      expect(
        projection.document.resources.find((resource) => resource.id === file.patchResourceId),
      ).toMatchObject({
        kind: "patch",
        fileKey: file.key,
        byteLength: new TextEncoder().encode(patch).byteLength,
        digest: reviewDigest(patch),
      });
    }

    const reordered = projectReviewDocument(
      {
        ...changeset,
        id: "reload-with-new-runtime-id",
        files: [
          { ...secondFile, id: "reload-b" },
          { ...firstFile, id: "reload-a" },
        ],
      },
      { generation: "generation:reload", sourceIdentity: "test:flattened-stream" },
    );
    const keyByPatch = (candidate: ReviewDocumentProjectionV1) =>
      new Map(
        candidate.document.files.map((file) => [
          candidate.resourceContents[file.patchResourceId],
          file.key,
        ]),
      );
    expect(keyByPatch(reordered)).toEqual(keyByPatch(projection));

    const identicalCopies = projectReviewDocument(
      {
        ...changeset,
        files: [firstFile, { ...firstFile, id: "commit-c" }],
      },
      {
        generation: "generation:identical-copies",
        sourceIdentity: "test:flattened-stream",
      },
    );
    expect(new Set(identicalCopies.document.files.map((file) => file.key)).size).toBe(2);
    expect(
      identicalCopies.document.files.map(
        (file) => identicalCopies.resourceContents[file.patchResourceId],
      ),
    ).toEqual([firstPatch, firstPatch]);
  });

  test("allocates document note ids globally across files", () => {
    const first = createTestDiffFile({
      id: "first",
      path: "first.ts",
      before: "const first = 1;\n",
      after: "const first = 2;\n",
      agent: { path: "first.ts", annotations: [{ id: "shared", summary: "first" }] },
    });
    const second = createTestDiffFile({
      id: "second",
      path: "second.ts",
      before: "const second = 1;\n",
      after: "const second = 2;\n",
      agent: { path: "second.ts", annotations: [{ id: "shared", summary: "second" }] },
    });
    const document = projectReviewDocument({
      id: "global-notes",
      sourceLabel: "repo:test",
      title: "Global notes",
      files: [first, second],
    }).document;
    expect(document.files.flatMap((file) => file.notes.map((note) => note.id))).toEqual([
      "shared",
      "shared:1",
    ]);
  });

  test("does not use the user-visible source label as default source identity", () => {
    const fixture = createTestReviewParityFixture();
    const first = projectReviewDocument({
      ...fixture.changeset,
      id: "stable-input",
      sourceLabel: "same basename",
    }).document;
    const relabeled = projectReviewDocument({
      ...fixture.changeset,
      id: "stable-input",
      sourceLabel: "different display label",
    }).document;
    expect(relabeled.documentIdentity).toBe(first.documentIdentity);
    expect(relabeled.files.map((file) => file.key)).toEqual(first.files.map((file) => file.key));
  });

  test("derives default generation from semantic content with an authoritative override", () => {
    const fixture = createTestReviewParityFixture();
    const projectionOptions = { sourceIdentity: "test:stable-input" };
    const first = projectReviewDocument(fixture.changeset, projectionOptions).document.generation;
    const equivalentReload = projectReviewDocument(
      {
        ...fixture.changeset,
        id: "same-content-new-runtime-id",
      },
      projectionOptions,
    ).document.generation;
    const changed = projectReviewDocument(
      {
        ...fixture.changeset,
        id: fixture.changeset.id,
        files: fixture.changeset.files.map((file, index) =>
          index === 0 ? { ...file, patch: `${file.patch}semantic-change\n` } : file,
        ),
      },
      projectionOptions,
    ).document.generation;

    expect(equivalentReload).toBe(first);
    expect(changed).not.toBe(first);
    expect(
      projectReviewDocument(fixture.changeset, { generation: "generation:authority" }).document
        .generation,
    ).toBe("generation:authority");
  });

  test("preserves hunk context and allocates unique note ids across all origins", () => {
    const fixture = createTestReviewParityFixture();
    const file = fixture.changeset.files[0]!;
    const withCollisions = {
      ...file,
      agent: {
        path: file.path,
        annotations: [
          { id: "duplicate", summary: "Sidecar first" },
          { id: "duplicate", summary: "Sidecar second" },
        ],
      },
    };
    const projection = projectReviewDocument(
      { ...fixture.changeset, files: [withCollisions] },
      {
        additionalNotesByFileId: {
          [withCollisions.id]: [
            {
              origin: "live-agent",
              annotation: { id: "duplicate", summary: "Live collision" },
            },
            {
              origin: "user",
              annotation: { id: "duplicate:1", summary: "Suffix collision", source: "user" },
            },
            {
              origin: "user",
              annotation: { id: "unique", summary: "No collision", source: "user" },
            },
          ],
        },
      },
    );
    const projected = projection.document.files[0]!;

    expect(projected.hunks[0]?.hunkContext).toBe("function renameValue()");
    expect(projected.notes.map((note) => note.id)).toEqual([
      "duplicate",
      "duplicate:1",
      "duplicate:2",
      "duplicate:1:1",
      "unique",
    ]);
    expect(new Set(projected.notes.map((note) => note.id)).size).toBe(projected.notes.length);
  });
});
