import { describe, expect, test } from "bun:test";
import {
  createTestSessionLiveComment,
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../../test/helpers/session-daemon-fixtures";
import {
  buildHunkSessionReview,
  buildListedHunkSession,
  buildSelectedHunkSessionContext,
  listHunkSessionComments,
} from "./projections";

function createEntry() {
  return {
    registration: createTestSessionRegistration(),
    snapshot: createTestSessionSnapshot(),
  };
}

describe("hunk session projections", () => {
  test("buildListedHunkSession keeps terminal metadata and file summaries", () => {
    const entry = {
      registration: createTestSessionRegistration({
        terminal: {
          program: "iTerm.app",
          locations: [{ source: "tty", tty: "/dev/ttys003" }],
        },
      }),
      snapshot: createTestSessionSnapshot(),
    };

    expect(buildListedHunkSession(entry)).toEqual(
      expect.objectContaining({
        terminal: entry.registration.terminal,
        fileCount: 1,
        files: [expect.objectContaining({ path: "src/example.ts", hunkCount: 1 })],
      }),
    );
  });

  test("buildSelectedHunkSessionContext projects the current file and selected ranges", () => {
    const session = buildListedHunkSession({
      registration: createTestSessionRegistration(),
      snapshot: createTestSessionSnapshot({
        selectedHunkIndex: 1,
        selectedHunkOldRange: [8, 8],
        selectedHunkNewRange: [8, 9],
      }),
    });

    expect(buildSelectedHunkSessionContext(session)).toEqual(
      expect.objectContaining({
        selectedFile: expect.objectContaining({ path: "src/example.ts" }),
        selectedHunk: {
          index: 1,
          oldRange: [8, 8],
          newRange: [8, 9],
        },
      }),
    );
  });

  test("buildHunkSessionReview strips patch text by default and includes it on demand", () => {
    const entry = createEntry();

    const withoutPatch = buildHunkSessionReview(entry);
    expect(withoutPatch.files[0]).not.toHaveProperty("patch");

    const withPatch = buildHunkSessionReview(entry, { includePatch: true });
    expect(withPatch.files[0]).toEqual(expect.objectContaining({ patch: "@@ -1,1 +1,1 @@" }));
  });

  test("listHunkSessionComments returns live comments and honors file filters", () => {
    const session = buildListedHunkSession({
      registration: createTestSessionRegistration(),
      snapshot: createTestSessionSnapshot({
        liveCommentCount: 2,
        liveComments: [
          createTestSessionLiveComment(),
          createTestSessionLiveComment({
            commentId: "comment-2",
            filePath: "src/other.ts",
            line: 9,
            summary: "Other",
          }),
        ],
      }),
    });

    expect(listHunkSessionComments(session)).toHaveLength(2);
    expect(listHunkSessionComments(session, { filePath: "src/example.ts" })).toEqual([
      expect.objectContaining({ commentId: "comment-1" }),
    ]);
  });
});
