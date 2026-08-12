import { createSkippedLargeMetadata } from "../../src/core/diffFile";
import type { ProjectReviewDocumentOptions } from "../../src/core/review/document";
import type { Changeset, DiffFile } from "../../src/core/types";
import { createTestDiffFile, lines } from "./diff-helpers";

export interface TestReviewParityFixture {
  changeset: Changeset;
  projectionOptions: ProjectReviewDocumentOptions;
}

/** Attach a representative exact per-file patch body to a test file. */
function withTestPatch(file: DiffFile, marker: string): DiffFile {
  return {
    ...file,
    patch: `diff --git a/${file.previousPath ?? file.path} b/${file.path}\n${marker}\n`,
  };
}

/**
 * Build the shared renderer-parity fixture in intentional narrative order.
 *
 * It includes every file/note/resource category in the Phase 0 contract while
 * remaining small enough for focused unit and future browser tests.
 */
export function createTestReviewParityFixture(): TestReviewParityFixture {
  const renamed = withTestPatch(
    createTestDiffFile({
      id: "rename-runtime",
      path: "src/new-name.ts",
      previousPath: "src/old-name.ts",
      before: lines("const before = 1;", "const shared = true;"),
      after: lines("const after = 2;", "const shared = true;"),
      agent: {
        path: "src/new-name.ts",
        summary: "Rename first because the sidecar sets narrative order.",
        annotations: [
          {
            id: "old-note",
            oldRange: [1, 1],
            summary: "Old-side text note",
            rationale: "Explains removed code.",
            tags: ["compatibility"],
            confidence: "high",
            source: "ai",
          },
          {
            id: "new-stml-note",
            newRange: [1, 1],
            summary: "New-side STML note",
            markup: "<p><strong>New</strong> implementation</p>",
            source: "agent",
            author: "Pi",
          },
          {
            id: "dual-note",
            oldRange: [1, 1],
            newRange: [1, 1],
            summary: "Dual-range note",
          },
          {
            id: "range-less-note",
            summary: "Whole-file note owned by the first hunk",
            title: "Overview",
          },
        ],
      },
    }),
    "rename patch",
  );
  renamed.metadata = {
    ...renamed.metadata,
    type: "rename-changed",
    prevName: "src/old-name.ts",
    hunks: renamed.metadata.hunks.map((hunk, index) =>
      index === 0 ? { ...hunk, hunkContext: "function renameValue()" } : hunk,
    ),
  };

  const deleted = withTestPatch(
    createTestDiffFile({
      id: "delete-runtime",
      path: "src/deleted.ts",
      previousPath: "src/deleted.ts",
      before: lines("export const removed = true;"),
      after: "",
    }),
    "delete patch",
  );
  const added = withTestPatch(
    createTestDiffFile({
      id: "add-runtime",
      path: "src/added.ts",
      before: "",
      after: lines("export const added = true;"),
    }),
    "add patch",
  );
  const untracked = {
    ...withTestPatch(
      createTestDiffFile({
        id: "untracked-runtime",
        path: "notes/untracked.txt",
        before: "",
        after: lines("untracked"),
      }),
      "untracked patch",
    ),
    isUntracked: true,
  };
  const binary = {
    ...withTestPatch(
      createTestDiffFile({
        id: "binary-runtime",
        path: "assets/logo.bin",
        agent: {
          path: "assets/logo.bin",
          annotations: [{ id: "hunkless-note", summary: "Hunkless file note" }],
        },
      }),
      "Binary files differ",
    ),
    metadata: createSkippedLargeMetadata("assets/logo.bin", "change"),
    isBinary: true,
  };
  const tooLarge = {
    ...withTestPatch(
      createTestDiffFile({ id: "large-runtime", path: "generated/large.txt" }),
      "large placeholder",
    ),
    metadata: createSkippedLargeMetadata("generated/large.txt", "change"),
    isTooLarge: true,
    statsTruncated: true,
  };
  const moved = withTestPatch(
    createTestDiffFile({
      id: "moved-runtime",
      path: "src/moved.ts",
      before: lines("first", "moved", "last"),
      after: lines("moved", "first", "last"),
      context: 0,
      sourceFetcher: {
        cacheKey: "source:moved:v1",
        async getFullText(side) {
          return side === "old" ? lines("first", "moved", "last") : lines("moved", "first", "last");
        },
      },
    }),
    "moved patch",
  );
  moved.lineMoveKinds = {
    additionLines: moved.metadata.additionLines.map((_line, index) =>
      index === 0 ? "moved" : undefined,
    ),
    deletionLines: moved.metadata.deletionLines.map((_line, index) =>
      index === 1 ? "moved" : undefined,
    ),
  };

  const files = [renamed, deleted, added, untracked, binary, tooLarge, moved];
  return {
    changeset: {
      id: "test-review-v1",
      sourceLabel: "test://renderer-parity",
      title: "Renderer parity fixture",
      summary: "Ordered multi-file semantic review",
      agentSummary: "Sidecar summary",
      files,
    },
    projectionOptions: {
      generation: "generation:test-v1",
      sourceIdentity: "test://renderer-parity",
      additionalNotesByFileId: {
        [renamed.id]: [
          {
            origin: "live-agent",
            annotation: {
              id: "live-note",
              source: "mcp",
              newRange: [1, 1],
              summary: "Live agent note",
              rationale: "Arrived through the session bridge.",
              author: "review-agent",
              createdAt: "2026-08-08T00:00:00.000Z",
            },
          },
          {
            origin: "user",
            editable: true,
            annotation: {
              id: "user-note",
              source: "user",
              oldRange: [1, 1],
              summary: "Saved user note",
              author: "You",
              createdAt: "2026-08-08T00:01:00.000Z",
              editable: true,
            },
          },
        ],
      },
      expandedContextByFileId: {
        [moved.id]: [
          {
            gapId: "trailing:0",
            side: "new",
            oldRange: [3, 3],
            newRange: [3, 3],
            sourceText: lines("moved", "first", "last"),
          },
        ],
      },
    },
  };
}
