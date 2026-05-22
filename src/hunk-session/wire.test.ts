import { describe, expect, test } from "bun:test";
import {
  MAX_REGISTRATION_FILES,
  MAX_REGISTRATION_HUNKS_PER_FILE,
  MAX_REGISTRATION_PATCH_BYTES,
  MAX_SNAPSHOT_LIVE_COMMENTS,
  MAX_SNAPSHOT_REVIEW_NOTES,
  SESSION_BROKER_REGISTRATION_VERSION,
} from "@hunk/session-broker-core";
import { parseSessionRegistration, parseSessionSnapshot } from "./wire";

function createRegistration(files: unknown[]) {
  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    launchedAt: "2026-03-22T00:00:00.000Z",
    info: { inputKind: "vcs", title: "repo working tree", sourceLabel: "/repo", files },
  };
}

function createFile(overrides: Record<string, unknown> = {}) {
  return {
    id: "file-1",
    path: "src/example.ts",
    additions: 1,
    deletions: 0,
    hunks: [{ index: 0, header: "@@ -1 +1 @@" }],
    ...overrides,
  };
}

function createValidComment(overrides: Record<string, unknown> = {}) {
  return {
    commentId: "comment-1",
    filePath: "src/example.ts",
    hunkIndex: 0,
    side: "new",
    line: 4,
    summary: "Review note",
    createdAt: "2026-03-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("hunk session wire parsing", () => {
  test("snapshot comment counts only include validated comment summaries", () => {
    const snapshot = parseSessionSnapshot({
      updatedAt: "2026-03-22T00:00:00.000Z",
      state: {
        selectedFileId: "file-1",
        selectedFilePath: "src/example.ts",
        selectedHunkIndex: 0,
        showAgentNotes: true,
        liveCommentCount: 5,
        liveComments: [
          createValidComment(),
          {
            filePath: "src/example.ts",
            summary: "Missing comment id and line.",
          },
        ],
      },
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.state.liveComments).toHaveLength(1);
    expect(snapshot?.state.liveCommentCount).toBe(1);
  });

  test("registration parses app info from the nested broker envelope", () => {
    const registration = parseSessionRegistration({
      registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
      sessionId: "session-1",
      pid: 123,
      cwd: "/repo",
      launchedAt: "2026-03-22T00:00:00.000Z",
      info: {
        inputKind: "vcs",
        title: "repo working tree",
        sourceLabel: "/repo",
        files: [],
      },
    });

    expect(registration?.info).toEqual({
      inputKind: "vcs",
      title: "repo working tree",
      sourceLabel: "/repo",
      files: [],
    });
  });

  test("rejects registrations with more files than the cap", () => {
    const files = Array.from({ length: MAX_REGISTRATION_FILES + 1 }, (_, index) =>
      createFile({ id: `file-${index}`, path: `src/file-${index}.ts` }),
    );

    expect(parseSessionRegistration(createRegistration(files))).toBeNull();
  });

  test("rejects files with more hunks than the per-file cap", () => {
    const hunks = Array.from({ length: MAX_REGISTRATION_HUNKS_PER_FILE + 1 }, (_, index) => ({
      index,
      header: `@@ hunk ${index} @@`,
    }));

    expect(parseSessionRegistration(createRegistration([createFile({ hunks })]))).toBeNull();
  });

  test("rejects files whose patch exceeds the byte cap", () => {
    const patch = "x".repeat(MAX_REGISTRATION_PATCH_BYTES + 1);

    expect(parseSessionRegistration(createRegistration([createFile({ patch })]))).toBeNull();
  });

  test("rejects snapshots with more live comments than the cap", () => {
    const liveComments = Array.from({ length: MAX_SNAPSHOT_LIVE_COMMENTS + 1 }, (_, index) =>
      createValidComment({ commentId: `comment-${index}` }),
    );

    const snapshot = parseSessionSnapshot({
      updatedAt: "2026-03-22T00:00:00.000Z",
      state: { selectedHunkIndex: 0, showAgentNotes: true, liveComments },
    });

    expect(snapshot).toBeNull();
  });

  test("rejects snapshots with more review notes than the cap", () => {
    const reviewNotes = Array.from({ length: MAX_SNAPSHOT_REVIEW_NOTES + 1 }, (_, index) => ({
      noteId: `note-${index}`,
      source: "user",
      filePath: "src/example.ts",
      body: "Looks good",
      createdAt: "2026-03-22T00:00:00.000Z",
    }));

    const snapshot = parseSessionSnapshot({
      updatedAt: "2026-03-22T00:00:00.000Z",
      state: { selectedHunkIndex: 0, showAgentNotes: true, liveComments: [], reviewNotes },
    });

    expect(snapshot).toBeNull();
  });
});
