import { buildExtensionReviewSnapshot } from "../../../packages/hunk/src/extensions/reviewSnapshot";
import type { ReviewSnapshotConsumer } from "../types";

/** Drive fixtures through the real public extension-snapshot projection. */
export const extensionReviewSnapshotConsumer: ReviewSnapshotConsumer = {
  name: "extension review snapshot",
  phase: "extension API v8",
  project(fixture) {
    const snapshot = buildExtensionReviewSnapshot(fixture.generation, fixture.build());
    return {
      generation: snapshot.generation,
      stateRevision: snapshot.stateRevision,
      files: snapshot.files.map(({ fileKey, contentIdentity }) => ({
        fileKey,
        contentIdentity,
      })),
      notes: snapshot.notes.map((note) => ({
        id: note.id,
        ...(note.parentId ? { parentId: note.parentId } : {}),
        fileKey: note.fileKey,
        resolution: note.resolution,
        ...(note.anchor.preferred ? { preferred: { ...note.anchor.preferred } } : {}),
        intersectingHunkIndices: [...note.anchor.intersectingHunkIndices],
        ...(note.anchor.ownerHunkIndex !== undefined
          ? { ownerHunkIndex: note.anchor.ownerHunkIndex }
          : {}),
      })),
    };
  },
};
