import { describe, expect, test } from "bun:test";
import {
  HUNK_SESSION_REGISTRATION_VERSION,
  parseSessionRegistration,
  parseSessionSnapshot,
} from "./sessionWire";

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

describe("session websocket wire parsing", () => {
  test("snapshot comment counts only include validated comment summaries", () => {
    const snapshot = parseSessionSnapshot({
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
      updatedAt: "2026-03-22T00:00:00.000Z",
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.liveComments).toHaveLength(1);
    expect(snapshot?.liveCommentCount).toBe(1);
  });

  test("registration requires the current websocket registration version", () => {
    expect(
      parseSessionRegistration({
        registrationVersion: HUNK_SESSION_REGISTRATION_VERSION - 1,
        sessionId: "session-1",
        pid: 123,
        cwd: "/repo",
        inputKind: "git",
        title: "repo working tree",
        sourceLabel: "/repo",
        launchedAt: "2026-03-22T00:00:00.000Z",
        files: [],
      }),
    ).toBeNull();
  });
});
