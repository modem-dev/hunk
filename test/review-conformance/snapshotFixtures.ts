import { createTestReviewState, createTestStoredNote } from "../helpers/review-store-helpers";
import type { ReviewSnapshotFixture } from "./types";

/** Complete saved-note cases that incremental extension events cannot reconstruct. */
export const REVIEW_SNAPSHOT_FIXTURES: readonly ReviewSnapshotFixture[] = [
  {
    id: "complete-saved-note-state",
    findings: ["EXT1"],
    description:
      "live, user, stale, and orphaned notes survive in collection order while a draft stays out",
    generation: "generation:conformance:3",
    build: () => ({
      ...createTestReviewState([
        { key: "alpha", contentIdentity: "content:alpha:v2" },
        { key: "beta", contentIdentity: "content:beta:v1" },
      ]),
      stateRevision: 6,
      liveNotes: [
        createTestStoredNote({ id: "live", fileKey: "alpha", line: 2 }),
        createTestStoredNote({
          id: "orphaned",
          fileKey: "retired",
          line: 1,
          resolution: "orphaned",
        }),
      ],
      userNotes: [
        createTestStoredNote({
          id: "user-stale",
          fileKey: "beta",
          hunkIndex: 1,
          line: 12,
          source: "user",
          resolution: "stale",
        }),
        createTestStoredNote({
          id: "reply",
          parentId: "live",
          fileKey: "alpha",
          line: 2,
          source: "user",
        }),
      ],
      draftNote: {
        id: "draft",
        fileKey: "alpha",
        hunkIndex: 0,
        side: "new" as const,
        line: 3,
        body: "not saved",
      },
    }),
    expected: {
      generation: "generation:conformance:3",
      stateRevision: 6,
      files: [
        { fileKey: "alpha", contentIdentity: "content:alpha:v2" },
        { fileKey: "beta", contentIdentity: "content:beta:v1" },
      ],
      notes: [
        {
          id: "live",
          fileKey: "alpha",
          resolution: "active",
          preferred: { side: "new", line: 2 },
          intersectingHunkIndices: [0],
          ownerHunkIndex: 0,
        },
        {
          id: "orphaned",
          fileKey: "retired",
          resolution: "orphaned",
          preferred: { side: "new", line: 1 },
          intersectingHunkIndices: [0],
          ownerHunkIndex: 0,
        },
        {
          id: "user-stale",
          fileKey: "beta",
          resolution: "stale",
          preferred: { side: "new", line: 12 },
          intersectingHunkIndices: [1],
          ownerHunkIndex: 1,
        },
        {
          id: "reply",
          parentId: "live",
          fileKey: "alpha",
          resolution: "active",
          preferred: { side: "new", line: 2 },
          intersectingHunkIndices: [0],
          ownerHunkIndex: 0,
        },
      ],
    },
  },
];
