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
  listHunkSessionNotes,
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
        experimentalFeatures: ["stml"],
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
        experimentalFeatures: ["stml"],
        fileCount: 1,
        files: [expect.objectContaining({ path: "src/example.ts", hunkCount: 1 })],
      }),
    );
  });

  test("buildSelectedHunkSessionContext projects the current file and selected ranges", () => {
    const session = buildListedHunkSession({
      registration: createTestSessionRegistration({ experimentalFeatures: ["stml"] }),
      snapshot: createTestSessionSnapshot({
        selectedHunkIndex: 1,
        selectedHunkOldRange: [8, 8],
        selectedHunkNewRange: [8, 9],
      }),
    });

    expect(buildSelectedHunkSessionContext(session)).toEqual(
      expect.objectContaining({
        experimentalFeatures: ["stml"],
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

  test("buildHunkSessionReview can include live review notes on demand", () => {
    const entry = {
      registration: createTestSessionRegistration(),
      snapshot: createTestSessionSnapshot({
        reviewNoteCount: 1,
        reviewNotes: [
          {
            noteId: "user:1",
            source: "user",
            filePath: "src/example.ts",
            body: "Please cover this case.",
            author: "user",
            createdAt: "2026-05-10T00:00:00.000Z",
            editable: true,
          },
        ],
      }),
    };

    expect(buildHunkSessionReview(entry).reviewNotes).toBeUndefined();
    expect(buildHunkSessionReview(entry, { includeNotes: true }).reviewNotes).toEqual([
      expect.objectContaining({ noteId: "user:1", source: "user" }),
    ]);
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

  test("listHunkSessionNotes filters by file and source", () => {
    const session = buildListedHunkSession({
      registration: createTestSessionRegistration(),
      snapshot: createTestSessionSnapshot({
        reviewNoteCount: 2,
        reviewNotes: [
          {
            noteId: "user:1",
            source: "user",
            filePath: "src/example.ts",
            body: "Human note",
            createdAt: "2026-05-10T00:00:00.000Z",
            editable: true,
          },
          {
            noteId: "agent:1",
            source: "agent",
            filePath: "src/other.ts",
            body: "Agent note",
            createdAt: "2026-05-10T00:00:00.000Z",
            editable: false,
          },
        ],
      }),
    });

    expect(listHunkSessionNotes(session, { source: "user" })).toEqual([
      expect.objectContaining({ noteId: "user:1" }),
    ]);
    expect(listHunkSessionNotes(session, { filePath: "src/other.ts" })).toEqual([
      expect.objectContaining({ noteId: "agent:1" }),
    ]);
  });
});
