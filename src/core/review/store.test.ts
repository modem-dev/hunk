import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, test } from "bun:test";
import {
  createTestDiffFile,
  createTestSourceFetcher,
  lines,
} from "../../../test/helpers/diff-helpers";
import { reviewSourceLineContextDigest } from "./anchors";
import { projectReviewDocument } from "./document";
import { reviewGapAddress } from "./expansion";
import { projectReviewNote } from "./notes";
import { reconcileReviewState, reviewLineAddress, reviewLineContextDigest } from "./reconcile";
import type { ReviewStoredNote } from "./state";
import { createReviewStore, prepareReviewState } from "./store";
import type { DiffFile } from "../types";

/** Build an ordered review document from small real diff files. */
function documentFor(files: DiffFile[], generation: string, sourceLabel = "repo:test") {
  return projectReviewDocument(
    { id: generation, sourceLabel, title: "Review", files },
    { generation, sourceIdentity: sourceLabel },
  ).document;
}

/** Build a compact patch-parsed file whose semantic line numbers exceed its array indices. */
function patchFile(id: string, secondHunkStart = 18): DiffFile {
  const path = "patch.ts";
  const patch = `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -3,3 +3,3 @@
 three
-old five
+new five
 six
@@ -${secondHunkStart},3 +${secondHunkStart},3 @@
 eighteen
-old twenty
+new twenty
 twenty-one
`;
  const metadata = parsePatchFiles(patch, id, true)[0]!.files[0]!;
  return {
    id,
    path,
    language: "typescript",
    metadata,
    patch,
    stats: { additions: 2, deletions: 2 },
    agent: null,
  };
}

/** Build one one-hunk file suitable for semantic store tests. */
function file(id: string, path: string, value: number) {
  return createTestDiffFile({
    id,
    path,
    before: `export const value = ${value};\n`,
    after: `export const value = ${value + 1};\n`,
  });
}

/** Build one stored mutable note at a file line. */
function storedNoteAt(
  document: ReturnType<typeof documentFor>,
  sourceFile: DiffFile,
  id: string,
  line = 1,
) {
  const semanticFile = document.files.find((entry) => entry.runtimeId === sourceFile.id)!;
  const note = projectReviewNote({
    annotation: {
      id,
      source: "mcp",
      summary: `note ${id}`,
      newRange: [line, line + 1],
      oldRange: [line, line + 1],
    },
    fileKey: semanticFile.key,
    hunks: sourceFile.metadata.hunks,
    origin: "live-agent",
  });
  return {
    note,
    resolution: "active" as const,
    contextDigest: reviewLineContextDigest(semanticFile, "new", line),
  };
}

/** Build one stored mutable note at a file's first changed line. */
function storedNote(document: ReturnType<typeof documentFor>, sourceFile: DiffFile, id: string) {
  return storedNoteAt(document, sourceFile, id);
}

describe("ReviewStore", () => {
  test("maps and rematches absolute patch lines through compact hunk arrays", () => {
    const previous = documentFor([patchFile("patch-before")], "generation:patch-before");
    const next = documentFor([patchFile("patch-after", 20)], "generation:patch-after");
    const previousFile = previous.files[0]!;
    expect(reviewLineAddress(previousFile, "new", 19)).toEqual({
      hunkIndex: 1,
      arrayIndex: 4,
    });
    expect(reviewLineAddress(previousFile, "new", 10)).toBeUndefined();
    const digest = reviewLineContextDigest(previousFile, "new", 19);
    expect(digest).toBeDefined();

    const store = createReviewStore(previous);
    store.dispatch({
      type: "selection/select",
      selection: {
        fileKey: previousFile.key,
        hunkIndex: 1,
        side: "new",
        line: 19,
        contextDigest: digest,
      },
    });
    store.dispatch({
      type: "draft/start",
      expectedGeneration: previous.generation,
      draft: {
        id: "draft:watch",
        fileKey: previousFile.key,
        hunkIndex: 1,
        side: "new",
        line: 19,
        newRange: [19, 19],
        body: "Do not lose this draft.",
      },
    });
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: previous.generation,
      document: next,
    });

    expect(store.getSnapshot().selection).toMatchObject({ hunkIndex: 1, side: "new", line: 21 });
    expect(store.getSnapshot().draftNote).toMatchObject({
      id: "draft:watch",
      body: "Do not lose this draft.",
      hunkIndex: 1,
      line: 21,
      newRange: [21, 21],
    });
  });

  test("prefers unique context over a replacement file retaining the old path", () => {
    const original = createTestDiffFile({
      id: "rename-original",
      path: "b.ts",
      before: lines("one", "two", "three", "old target", "five", "six", "seven"),
      after: lines("one", "two", "three", "unique target", "five", "six", "seven"),
    });
    const previous = documentFor([original], "generation:rename-before");
    const previousFile = previous.files[0]!;
    const store = createReviewStore(previous);
    const digest = reviewLineContextDigest(previousFile, "new", 4);
    store.dispatch({
      type: "selection/select",
      selection: {
        fileKey: previousFile.key,
        hunkIndex: 0,
        side: "new",
        line: 4,
        contextDigest: digest,
      },
    });
    store.dispatch({
      type: "draft/start",
      expectedGeneration: previous.generation,
      draft: {
        id: "draft:rename",
        fileKey: previousFile.key,
        hunkIndex: 0,
        side: "new",
        line: 4,
        newRange: [4, 4],
        body: "Follow the renamed content.",
      },
    });
    const replacement = createTestDiffFile({
      id: "path-replacement",
      path: "b.ts",
      before: "replacement old\n",
      after: "replacement new\n",
    });
    const renamed = createTestDiffFile({
      id: "rename-target",
      path: "c.ts",
      previousPath: "b.ts",
      before: lines("prefix", "one", "two", "three", "old target", "five", "six", "seven"),
      after: lines("prefix", "one", "two", "three", "unique target", "five", "six", "seven"),
    });
    const next = documentFor([replacement, renamed], "generation:rename-after");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: previous.generation,
      document: next,
    });

    const renamedFile = next.files.find((file) => file.path === "c.ts")!;
    expect(store.getSnapshot().selection).toMatchObject({
      fileKey: renamedFile.key,
      side: "new",
      line: 5,
    });
    expect(store.getSnapshot().draftNote).toMatchObject({
      fileKey: renamedFile.key,
      line: 5,
      body: "Follow the renamed content.",
    });
  });

  test("publishes synchronously and increments revisions only for real mutations", () => {
    const document = documentFor([file("alpha", "alpha.ts", 1)], "generation:one");
    const store = createReviewStore(document);
    const observed: number[] = [];
    store.subscribe(() => observed.push(store.getSnapshot().stateRevision));

    const returned = store.dispatch({ type: "filter/set", filter: "alpha" });
    expect(returned).toBe(store.getSnapshot());
    expect(returned.stateRevision).toBe(1);
    expect(observed).toEqual([1]);

    store.dispatch({ type: "filter/set", filter: "alpha" });
    expect(store.getSnapshot().stateRevision).toBe(1);
    expect(observed).toEqual([1]);

    const fileKey = document.files[0]!.key;
    store.dispatch({
      type: "expansion/set-source-status",
      expectedGeneration: document.generation,
      fileKey,
      status: { kind: "loading" },
    });
    store.dispatch({
      type: "expansion/set-source-status",
      expectedGeneration: document.generation,
      fileKey,
      status: { kind: "loading" },
    });
    expect(store.getSnapshot().stateRevision).toBe(2);
    expect(observed).toEqual([1, 2]);
  });

  test("preflights dispatches and prepared commits before revision publication", () => {
    const document = documentFor([file("alpha", "alpha.ts", 1)], "generation:one");
    let reject = true;
    const validated: number[] = [];
    const store = createReviewStore(document, {
      validateNextSnapshot(next) {
        validated.push(next.stateRevision);
        if (reject) throw new Error("snapshot rejected");
      },
    });
    const observed: number[] = [];
    store.subscribe(() => observed.push(store.getSnapshot().stateRevision));
    const initial = store.getSnapshot();

    expect(() => store.dispatch({ type: "filter/set", filter: "alpha" })).toThrow(
      "snapshot rejected",
    );
    expect(store.getSnapshot()).toBe(initial);
    expect(observed).toEqual([]);

    const prepared = prepareReviewState(initial, [{ type: "notes/set-visibility", visible: true }]);
    expect(() => store.commitPrepared(initial, prepared)).toThrow("snapshot rejected");
    expect(store.getSnapshot()).toBe(initial);
    expect(observed).toEqual([]);

    reject = false;
    expect(store.dispatch({ type: "filter/set", filter: "alpha" }).stateRevision).toBe(1);
    expect(validated).toEqual([1, 1, 1]);
    expect(observed).toEqual([1]);
  });

  test("shares filter fallback and semantic selection across file reorder", () => {
    const alpha = file("alpha", "alpha.ts", 1);
    const beta = file("beta", "beta.ts", 2);
    const first = documentFor([alpha, beta], "generation:one");
    const store = createReviewStore(first);
    const betaKey = first.files[1]!.key;

    store.dispatch({
      type: "selection/select",
      selection: { fileKey: betaKey, hunkIndex: 0, side: "new", line: 1 },
    });
    store.dispatch({ type: "filter/set", filter: "alpha" });
    expect(store.getSnapshot().selection.fileKey).toBe(first.files[0]!.key);
    store.dispatch({ type: "filter/set", filter: "" });
    store.dispatch({
      type: "selection/select",
      selection: { fileKey: betaKey, hunkIndex: 0, side: "new", line: 1 },
    });

    const reordered = documentFor(
      [
        { ...beta, id: "beta-reload" },
        { ...alpha, id: "alpha-reload" },
      ],
      "generation:two",
    );
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: "generation:one",
      document: reordered,
    });
    expect(store.getSnapshot().selection.fileKey).toBe(betaKey);
    expect(reordered.files.find((entry) => entry.key === betaKey)?.path).toBe("beta.ts");
  });

  test("reconciles live and user notes without sidecar reorder moving them", () => {
    const alpha = file("alpha", "alpha.ts", 1);
    const beta = file("beta", "beta.ts", 2);
    const first = documentFor([alpha, beta], "generation:one");
    const store = createReviewStore(first);
    const live = storedNote(first, beta, "live:1");
    const user = {
      ...storedNote(first, beta, "user:1"),
      note: {
        ...storedNote(first, beta, "user:1").note,
        source: "user" as const,
        origin: "user" as const,
      },
    };
    store.dispatch({
      type: "notes/add-live",
      expectedGeneration: first.generation,
      notes: [live],
    });
    store.dispatch({
      type: "draft/start",
      expectedGeneration: first.generation,
      draft: {
        id: "draft:1",
        fileKey: user.note.fileKey,
        hunkIndex: 0,
        side: "new",
        line: 1,
        body: "user",
      },
    });
    store.dispatch({ type: "draft/save", expectedGeneration: first.generation, note: user });

    const reordered = documentFor([beta, alpha], "generation:two");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: first.generation,
      document: reordered,
    });
    expect(store.getSnapshot().liveNotes[0]).toMatchObject({
      resolution: "active",
      note: { fileKey: reordered.files[0]!.key },
    });
    expect(store.getSnapshot().userNotes[0]).toMatchObject({
      resolution: "active",
      note: { fileKey: reordered.files[0]!.key },
    });
  });

  test("retains notes on removed files as explicit orphans", () => {
    const alpha = file("alpha", "alpha.ts", 1);
    const first = documentFor([alpha], "generation:one");
    const store = createReviewStore(first);
    store.dispatch({
      type: "notes/add-live",
      expectedGeneration: first.generation,
      notes: [storedNote(first, alpha, "live:orphan")],
    });
    const empty = documentFor([], "generation:two");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: first.generation,
      document: empty,
    });
    expect(store.getSnapshot().liveNotes[0]?.resolution).toBe("orphaned");
    expect(store.getSnapshot().selection.fileKey).toBeNull();
  });

  test("preserves valid gaps but resets unproven source text across generations", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const after = [...before];
    after[9] = "line 10 changed";
    const alpha = createTestDiffFile({
      id: "alpha",
      path: "alpha.ts",
      before: lines(...before),
      after: lines(...after),
      sourceFetcher: {
        ...createTestSourceFetcher(() => "alpha-source"),
        cacheKey: "source:alpha",
      },
    });
    const beta = file("beta", "beta.ts", 1);
    const first = documentFor([alpha, beta], "generation:one");
    const store = createReviewStore(first);
    const semanticAlpha = first.files[0]!;
    const hunk = semanticAlpha.hunks[0]!;
    const side = "new" as const;
    const source = first.resources.find(
      (resource) => resource.id === semanticAlpha.sourceResourceIds[side],
    );
    expect(source?.kind).toBe("source");
    store.dispatch({
      type: "expansion/toggle",
      expectedGeneration: first.generation,
      gap: {
        fileKey: semanticAlpha.key,
        gapId: "before:0",
        side,
        oldRange: [hunk.deletionStart - hunk.collapsedBefore, hunk.deletionStart - 1],
        newRange: [hunk.additionStart - hunk.collapsedBefore, hunk.additionStart - 1],
        sourceIdentity: source!.kind === "source" ? source!.sourceIdentity : "",
        expanded: true,
      },
    });
    store.dispatch({
      type: "expansion/set-source-status",
      expectedGeneration: first.generation,
      fileKey: semanticAlpha.key,
      status: { kind: "loaded", text: lines(...after) },
    });

    const reordered = documentFor([beta, alpha], "generation:two");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: first.generation,
      document: reordered,
    });
    expect(store.getSnapshot().expandedGaps).toHaveLength(1);
    expect(store.getSnapshot().sourceStatusByFileKey[semanticAlpha.key]).toBeUndefined();

    const changedSource = {
      ...reordered,
      generation: "generation:three",
      resources: reordered.resources.map((resource) =>
        resource.kind === "source" && resource.fileKey === semanticAlpha.key
          ? { ...resource, generation: "generation:three", sourceIdentity: "source:changed" }
          : { ...resource, generation: "generation:three" },
      ),
    };
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: reordered.generation,
      document: changedSource,
    });
    expect(store.getSnapshot().expandedGaps).toEqual([]);
    expect(store.getSnapshot().sourceStatusByFileKey).toEqual({});
  });

  test("drops malformed, non-final, partial, and unequal trailing gaps during reconciliation", () => {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const after = [...before];
    after[4] = "line 5 changed";
    after[19] = "line 20 changed";
    const sourceFile = createTestDiffFile({
      id: "trailing",
      path: "trailing.ts",
      before: lines(...before),
      after: lines(...after),
      sourceFetcher: {
        ...createTestSourceFetcher(() => lines(...after)),
        cacheKey: "source:trailing",
      },
    });
    const first = documentFor([sourceFile], "generation:one");
    const semantic = first.files[0]!;
    expect(semantic.hunks).toHaveLength(2);
    const validAddress = reviewGapAddress(semantic, "trailing:1")!;
    const source = first.resources.find(
      (resource) => resource.id === semantic.sourceResourceIds.new,
    )!;
    expect(source.kind).toBe("source");
    const sourceIdentity = source.kind === "source" ? source.sourceIdentity : "";
    const initial = createReviewStore(first).getSnapshot();
    const validGap = {
      fileKey: semantic.key,
      gapId: "trailing:1",
      side: "new" as const,
      ...validAddress,
      sourceIdentity,
      expanded: true,
    };
    const nextDocument = (file: typeof semantic) => ({
      ...first,
      generation: "generation:two",
      files: [file],
      resources: first.resources.map((resource) => ({
        ...resource,
        generation: "generation:two",
      })),
    });
    const cases = [
      {
        gap: { ...validGap, gapId: "trailing:not-an-index" },
        previousDocument: first,
        document: nextDocument(semantic),
      },
      {
        gap: { ...validGap, gapId: "trailing:0" },
        previousDocument: first,
        document: nextDocument(semantic),
      },
      {
        gap: validGap,
        previousDocument: first,
        document: nextDocument({ ...semantic, flags: { ...semantic.flags, partial: true } }),
      },
      {
        gap: validGap,
        previousDocument: first,
        document: nextDocument({
          ...semantic,
          additionLines: semantic.additionLines.slice(0, -1),
        }),
      },
      {
        gap: validGap,
        previousDocument: {
          ...first,
          files: [{ ...semantic, flags: { ...semantic.flags, partial: true } }],
        },
        document: nextDocument(semantic),
      },
      {
        gap: validGap,
        previousDocument: {
          ...first,
          files: [
            {
              ...semantic,
              additionLines: semantic.additionLines.slice(0, -1),
            },
          ],
        },
        document: nextDocument(semantic),
      },
    ];

    for (const candidate of cases) {
      const reconciled = reconcileReviewState(
        {
          ...initial,
          document: candidate.previousDocument,
          expandedGaps: [candidate.gap],
        },
        candidate.document,
      );
      expect(reconciled.expandedGaps).toEqual([]);
      expect(reconciled.sourceStatusByFileKey).toEqual({});
    }
  });

  test("preserves loaded source only when materialized digests prove equality", () => {
    const sourceFile = createTestDiffFile({
      id: "materialized",
      path: "materialized.ts",
      before: lines(...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)),
      after: lines(
        ...Array.from({ length: 20 }, (_, index) =>
          index === 9 ? "line 10 changed" : `line ${index + 1}`,
        ),
      ),
      sourceFetcher: {
        ...createTestSourceFetcher(() => "source"),
        cacheKey: "source:materialized",
      },
    });
    const projection = (generation: string) =>
      projectReviewDocument(
        { id: generation, sourceLabel: "repo:test", title: "Review", files: [sourceFile] },
        {
          generation,
          sourceIdentity: "repo:test",
          expandedContextByFileId: {
            [sourceFile.id]: [
              {
                gapId: "before:0",
                side: "new",
                oldRange: [1, 9],
                newRange: [1, 9],
                sourceText: "materialized source\n",
              },
            ],
          },
        },
      ).document;
    const first = projection("generation:one");
    const store = createReviewStore(first);
    const semantic = first.files[0]!;
    const expanded = semantic.expandedContext[0]!;
    const source = first.resources.find((resource) => resource.id === expanded.sourceResourceId)!;
    store.dispatch({
      type: "expansion/toggle",
      expectedGeneration: first.generation,
      gap: {
        fileKey: semantic.key,
        gapId: expanded.gapId,
        side: expanded.side,
        oldRange: expanded.oldRange,
        newRange: expanded.newRange,
        sourceIdentity: source.kind === "source" ? source.sourceIdentity : "",
        expanded: true,
      },
    });
    store.dispatch({
      type: "expansion/set-source-status",
      expectedGeneration: first.generation,
      fileKey: semantic.key,
      status: { kind: "loaded", text: "materialized source\n" },
    });
    const next = projection("generation:two");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: first.generation,
      document: next,
    });
    expect(store.getSnapshot().expandedGaps).toHaveLength(1);
    expect(store.getSnapshot().sourceStatusByFileKey[semantic.key]).toEqual({
      kind: "loaded",
      text: "materialized source\n",
    });
  });

  test("preserves only proven expanded-note placement while keeping reload resolution stale", () => {
    const before = lines("old one", "hidden two", "hidden three", "hidden four", "old five");
    const after = lines("new one", "hidden two", "hidden three", "hidden four", "new five");
    const changedSource = lines(
      "new one",
      "hidden two changed",
      "hidden three",
      "hidden four",
      "new five",
    );
    const sourceFile = createTestDiffFile({
      id: "expanded-note",
      path: "expanded-note.ts",
      before,
      after,
      context: 0,
      sourceFetcher: {
        ...createTestSourceFetcher(() => after),
        cacheKey: "source:expanded-note",
      },
    });
    const seed = documentFor([sourceFile], "generation:seed");
    const gap = reviewGapAddress(seed.files[0]!, "before:1")!;
    const projection = (generation: string, sourceText: string) =>
      projectReviewDocument(
        { id: generation, sourceLabel: "repo:test", title: "Review", files: [sourceFile] },
        {
          generation,
          sourceIdentity: "repo:test",
          expandedContextByFileId: {
            [sourceFile.id]: [
              {
                gapId: "before:1",
                side: "new",
                ...gap,
                sourceText,
              },
            ],
          },
        },
      ).document;
    const first = projection("generation:one", after);
    const semantic = first.files[0]!;
    const line = gap.newRange[0];
    const expandedNote = {
      note: {
        id: "user:expanded",
        source: "user" as const,
        origin: "user" as const,
        originalSource: "user",
        fileKey: semantic.key,
        anchor: {
          newRange: [line, line] as [number, number],
          preferred: { side: "new" as const, line },
          intersectingHunkIndices: [],
          ownerHunkIndex: 1,
        },
        summary: "Expanded source rationale",
        createdAt: "2026-01-01T00:00:00.000Z",
        editable: true,
      },
      contextDigest: reviewSourceLineContextDigest(after, line),
      contextDigests: { new: reviewSourceLineContextDigest(after, line)! },
      resolution: "active" as const,
    };
    const reconcileNote = (nextSource: string, note: ReviewStoredNote = expandedNote) => {
      const store = createReviewStore(first);
      store.dispatch({
        type: "notes/add-user",
        expectedGeneration: first.generation,
        note,
      });
      store.dispatch({
        type: "document/reconcile",
        expectedGeneration: first.generation,
        document: projection(`generation:${nextSource === after ? "same" : "changed"}`, nextSource),
      });
      return store.getSnapshot().userNotes[0]!;
    };

    expect(reconcileNote(after)).toMatchObject({
      resolution: "stale",
      note: { anchor: { intersectingHunkIndices: [], ownerHunkIndex: 1 } },
    });
    expect(reconcileNote(changedSource)).toMatchObject({
      resolution: "stale",
      note: { anchor: { intersectingHunkIndices: [], ownerHunkIndex: 1 } },
    });
    const {
      contextDigest: _contextDigest,
      contextDigests: _contextDigests,
      ...ordinaryUnmatchedNote
    } = expandedNote;
    expect(reconcileNote(after, ordinaryUnmatchedNote)).toMatchObject({
      resolution: "stale",
      note: { anchor: { intersectingHunkIndices: [], ownerHunkIndex: 0 } },
    });
  });

  test("does not reconcile selection, notes, or expansions through paths in another source", () => {
    const sourceFile = createTestDiffFile({
      id: "same-a",
      path: "same.ts",
      before: lines(...Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)),
      after: lines(
        ...Array.from({ length: 12 }, (_, index) =>
          index === 5 ? "line 6 changed" : `line ${index + 1}`,
        ),
      ),
      sourceFetcher: {
        ...createTestSourceFetcher(() => "source"),
        cacheKey: "shared-cache-key",
      },
    });
    const first = documentFor([sourceFile], "generation:one", "repo:first");
    const store = createReviewStore(first);
    const semantic = first.files[0]!;
    const hunk = semantic.hunks[0]!;
    store.dispatch({
      type: "selection/set-line",
      fileKey: semantic.key,
      hunkIndex: 0,
      side: "new",
      line: 6,
      contextDigest: reviewLineContextDigest(semantic, "new", 6),
    });
    store.dispatch({
      type: "notes/add-live",
      expectedGeneration: first.generation,
      notes: [storedNoteAt(first, sourceFile, "live:cross-source", 6)],
    });
    store.dispatch({
      type: "expansion/toggle",
      expectedGeneration: first.generation,
      gap: {
        fileKey: semantic.key,
        gapId: "before:0",
        side: "new",
        oldRange: [hunk.deletionStart - hunk.collapsedBefore, hunk.deletionStart - 1],
        newRange: [hunk.additionStart - hunk.collapsedBefore, hunk.additionStart - 1],
        sourceIdentity: "shared-cache-key",
        expanded: true,
      },
    });

    const other = documentFor([{ ...sourceFile, id: "same-b" }], "generation:two", "repo:other");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: first.generation,
      document: other,
    });

    expect(store.getSnapshot().selection).toEqual({ fileKey: other.files[0]!.key, hunkIndex: 0 });
    expect(store.getSnapshot().liveNotes[0]?.resolution).toBe("orphaned");
    expect(store.getSnapshot().expandedGaps).toEqual([]);
  });

  test("falls back to the first filtered file when reload changes filter matches", () => {
    const alpha = file("alpha", "alpha.ts", 1);
    const beta = file("beta", "beta.ts", 2);
    const firstBase = documentFor([alpha, beta], "generation:one");
    const first = {
      ...firstBase,
      files: firstBase.files.map((entry) => ({
        ...entry,
        agentSummary: entry.path === "beta.ts" ? "needle" : undefined,
      })),
    };
    const store = createReviewStore(first);
    store.dispatch({ type: "filter/set", filter: "needle" });
    expect(store.getSnapshot().selection.fileKey).toBe(first.files[1]!.key);

    const nextBase = documentFor([beta, alpha], "generation:two");
    const next = {
      ...nextBase,
      files: nextBase.files.map((entry) => ({
        ...entry,
        agentSummary: entry.path === "alpha.ts" ? "needle" : undefined,
      })),
    };
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: first.generation,
      document: next,
    });
    expect(store.getSnapshot().selection).toEqual({ fileKey: next.files[1]!.key, hunkIndex: 0 });
  });

  test("updates every anchor field when note context moves", () => {
    const originalLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const changedLines = [...originalLines];
    changedLines[5] = "line 6 changed";
    const original = createTestDiffFile({
      id: "moved",
      path: "moved.ts",
      before: lines(...originalLines),
      after: lines(...changedLines),
    });
    const first = documentFor([original], "generation:one");
    const store = createReviewStore(first);
    store.dispatch({
      type: "notes/add-live",
      expectedGeneration: first.generation,
      notes: [storedNoteAt(first, original, "live:moved", 6)],
    });

    const prefix = ["prefix 1", "prefix 2", "prefix 3"];
    const moved = createTestDiffFile({
      id: "moved-reload",
      path: "moved.ts",
      before: lines(...prefix, ...originalLines),
      after: lines(...prefix, ...changedLines),
    });
    const next = documentFor([moved], "generation:two");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: first.generation,
      document: next,
    });

    const entry = store.getSnapshot().liveNotes[0]!;
    expect(entry.resolution).toBe("active");
    expect(entry.note.anchor).toEqual({
      oldRange: [9, 10],
      newRange: [9, 10],
      preferred: { side: "new", line: 9 },
      intersectingHunkIndices: [0],
      ownerHunkIndex: 0,
    });
    expect(entry.contextDigest).toBe(reviewLineContextDigest(next.files[0]!, "new", 9));
  });

  test("rematches dual ranges independently when only the new side moves", () => {
    const originalLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const changedLines = [...originalLines];
    changedLines[5] = "line 6 changed";
    const original = createTestDiffFile({
      id: "asymmetric",
      path: "asymmetric.ts",
      before: lines(...originalLines),
      after: lines(...changedLines),
    });
    const first = documentFor([original], "generation:one");
    const store = createReviewStore(first);
    store.dispatch({
      type: "notes/add-live",
      expectedGeneration: first.generation,
      notes: [storedNoteAt(first, original, "live:asymmetric", 6)],
    });
    store.dispatch({
      type: "draft/start",
      expectedGeneration: first.generation,
      draft: {
        id: "draft:asymmetric",
        fileKey: first.files[0]!.key,
        hunkIndex: 0,
        side: "new",
        line: 6,
        oldRange: [6, 7],
        newRange: [6, 7],
        body: "Preserve both sides independently.",
      },
    });

    const prefix = ["prefix 1", "prefix 2", "prefix 3"];
    const movedNewSide = createTestDiffFile({
      id: "asymmetric-reload",
      path: "asymmetric.ts",
      before: lines(...originalLines),
      after: lines(...prefix, ...changedLines),
    });
    const next = documentFor([movedNewSide], "generation:two");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: first.generation,
      document: next,
    });

    expect(store.getSnapshot().liveNotes[0]).toMatchObject({
      resolution: "active",
      note: {
        anchor: {
          oldRange: [6, 7],
          newRange: [9, 10],
          preferred: { side: "new", line: 9 },
        },
      },
    });
    expect(store.getSnapshot().draftNote).toMatchObject({
      id: "draft:asymmetric",
      line: 9,
      oldRange: [6, 7],
      newRange: [9, 10],
      body: "Preserve both sides independently.",
    });
  });

  test("marks a dual-range note stale when one declared side cannot be verified", () => {
    const originalLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    const changedLines = [...originalLines];
    changedLines[5] = "line 6 changed";
    const original = createTestDiffFile({
      id: "unverified",
      path: "unverified.ts",
      before: lines(...originalLines),
      after: lines(...changedLines),
    });
    const first = documentFor([original], "generation:one");
    const store = createReviewStore(first);
    store.dispatch({
      type: "notes/add-live",
      expectedGeneration: first.generation,
      notes: [storedNoteAt(first, original, "live:unverified", 6)],
    });
    store.dispatch({
      type: "draft/start",
      expectedGeneration: first.generation,
      draft: {
        id: "draft:unverified",
        fileKey: first.files[0]!.key,
        hunkIndex: 0,
        side: "new",
        line: 6,
        oldRange: [6, 7],
        newRange: [6, 7],
        body: "Do not save a partially stale anchor.",
      },
    });
    const replacedOldSide = createTestDiffFile({
      id: "unverified-reload",
      path: "unverified.ts",
      before: lines(...Array.from({ length: 12 }, (_, index) => `replacement ${index + 1}`)),
      after: lines("prefix 1", "prefix 2", "prefix 3", ...changedLines),
    });
    const next = documentFor([replacedOldSide], "generation:two");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: first.generation,
      document: next,
    });
    expect(store.getSnapshot().liveNotes[0]).toMatchObject({
      resolution: "stale",
      contextDigest: reviewLineContextDigest(next.files[0]!, "new", 9),
      note: { anchor: { oldRange: [6, 7], newRange: [9, 10] } },
    });
    expect(store.getSnapshot().draftNote).toBeNull();
  });

  test("reattaches orphan notes when their source-scoped file and context return", () => {
    const alpha = file("alpha", "alpha.ts", 1);
    const first = documentFor([alpha], "generation:one");
    const store = createReviewStore(first);
    store.dispatch({
      type: "notes/add-live",
      expectedGeneration: first.generation,
      notes: [storedNote(first, alpha, "live:return")],
    });
    const empty = documentFor([], "generation:two");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: first.generation,
      document: empty,
    });
    const returned = documentFor([{ ...alpha, id: "alpha-returned" }], "generation:three");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: empty.generation,
      document: returned,
    });
    expect(store.getSnapshot().liveNotes[0]).toMatchObject({
      resolution: "active",
      note: { fileKey: returned.files[0]!.key },
    });
  });

  test("disambiguates mutable note ids globally and removes only one addressed note", () => {
    const alpha = {
      ...file("alpha", "alpha.ts", 1),
      agent: { path: "alpha.ts", annotations: [{ id: "duplicate", summary: "document" }] },
    };
    const document = documentFor([alpha], "generation:one");
    const store = createReviewStore(document);
    const first = storedNote(document, alpha, "duplicate");
    store.dispatch({
      type: "notes/add-live",
      expectedGeneration: document.generation,
      notes: [first, first],
    });
    expect(store.getSnapshot().liveNotes.map((entry) => entry.note.id)).toEqual([
      "duplicate:1",
      "duplicate:2",
    ]);
    store.dispatch({
      type: "notes/remove-live",
      expectedGeneration: document.generation,
      noteId: "duplicate:1",
    });
    expect(store.getSnapshot().liveNotes.map((entry) => entry.note.id)).toEqual(["duplicate:2"]);
  });

  test("disambiguates retained mutable ids when replacement document introduces a collision", () => {
    const alpha = file("alpha", "alpha.ts", 1);
    const first = documentFor([alpha], "generation:one");
    const store = createReviewStore(first);
    store.dispatch({
      type: "notes/add-live",
      expectedGeneration: first.generation,
      notes: [storedNote(first, alpha, "arriving")],
    });
    const annotated = {
      ...alpha,
      agent: { path: alpha.path, annotations: [{ id: "arriving", summary: "document note" }] },
    };
    const next = documentFor([annotated], "generation:two");
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: first.generation,
      document: next,
    });
    expect(next.files[0]!.notes[0]!.id).toBe("arriving");
    expect(store.getSnapshot().liveNotes[0]!.note.id).toBe("arriving:1");
  });

  test("treats equivalent reconcile and draft starts as no-ops but context changes as mutations", () => {
    const document = documentFor([file("alpha", "alpha.ts", 1)], "generation:one");
    const store = createReviewStore(document);
    store.dispatch({
      type: "document/reconcile",
      expectedGeneration: document.generation,
      document: structuredClone(document),
    });
    expect(store.getSnapshot().stateRevision).toBe(0);
    const draft = {
      id: "draft:one",
      fileKey: document.files[0]!.key,
      hunkIndex: 0,
      side: "new" as const,
      line: 1,
      body: "",
    };
    store.dispatch({ type: "draft/start", expectedGeneration: document.generation, draft });
    store.dispatch({
      type: "draft/start",
      expectedGeneration: document.generation,
      draft: structuredClone(draft),
    });
    expect(store.getSnapshot().stateRevision).toBe(0);
    store.dispatch({
      type: "selection/set-line",
      fileKey: document.files[0]!.key,
      hunkIndex: 0,
      side: "new",
      line: 1,
      contextDigest: "digest:first",
    });
    store.dispatch({
      type: "selection/set-line",
      fileKey: document.files[0]!.key,
      hunkIndex: 0,
      side: "new",
      line: 1,
      contextDigest: "digest:second",
    });
    expect(store.getSnapshot().selection.contextDigest).toBe("digest:second");
    expect(store.getSnapshot().stateRevision).toBe(2);
  });

  test("notifies local draft listeners without validation or published revision churn", () => {
    const document = documentFor([file("alpha", "alpha.ts", 1)], "generation:one");
    const validated: number[] = [];
    const observed: string[] = [];
    const published: number[] = [];
    const store = createReviewStore(document, {
      validateNextSnapshot(next) {
        validated.push(next.stateRevision);
      },
    });
    store.subscribe(() => observed.push(store.getSnapshot().draftNote?.body ?? "cancelled"));
    store.subscribePublished(() => published.push(store.getSnapshot().stateRevision));
    const draft = {
      id: "draft:one",
      fileKey: document.files[0]!.key,
      hunkIndex: 0,
      side: "new" as const,
      line: 1,
      body: "",
    };

    const initial = store.getSnapshot();
    store.dispatch({ type: "draft/start", expectedGeneration: document.generation, draft });
    const started = store.getSnapshot();
    store.dispatch({
      type: "draft/update",
      expectedGeneration: document.generation,
      body: "draft text",
    });
    store.dispatch({ type: "draft/cancel", expectedGeneration: document.generation });

    expect(started).not.toBe(initial);
    expect(store.getSnapshot().stateRevision).toBe(0);
    expect(observed).toEqual(["", "draft text", "cancelled"]);
    expect(validated).toEqual([]);
    expect(published).toEqual([]);
  });

  test("publishes draft save as one validated semantic revision", () => {
    const alpha = file("alpha", "alpha.ts", 1);
    const document = documentFor([alpha], "generation:one");
    const validated: number[] = [];
    const published: number[] = [];
    const store = createReviewStore(document, {
      validateNextSnapshot(next) {
        validated.push(next.stateRevision);
      },
    });
    store.subscribePublished(() => published.push(store.getSnapshot().stateRevision));
    store.dispatch({
      type: "draft/start",
      expectedGeneration: document.generation,
      draft: {
        id: "draft:one",
        fileKey: document.files[0]!.key,
        hunkIndex: 0,
        side: "new",
        line: 1,
        body: "saved text",
      },
    });
    const user = storedNote(document, alpha, "user:saved");
    user.note.summary = "saved text";
    store.dispatch({ type: "draft/save", expectedGeneration: document.generation, note: user });

    expect(store.getSnapshot()).toMatchObject({
      stateRevision: 1,
      draftNote: null,
      userNotes: [{ note: { id: "user:saved", summary: "saved text" } }],
    });
    expect(validated).toEqual([1]);
    expect(published).toEqual([1]);
  });

  test("rejects stale generation note and expansion actions", () => {
    const alpha = file("alpha", "alpha.ts", 1);
    const document = documentFor([alpha], "generation:current");
    const store = createReviewStore(document);
    expect(() =>
      store.dispatch({
        type: "notes/add-live",
        expectedGeneration: "generation:stale",
        notes: [],
      }),
    ).toThrow("Stale review action");
    expect(store.getSnapshot().stateRevision).toBe(0);
  });
});
