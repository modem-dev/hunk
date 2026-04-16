import { describe, expect, test } from "bun:test";
import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import { parseSessionRegistration, parseSessionSnapshot } from "./wire";

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
        inputKind: "git",
        title: "repo working tree",
        sourceLabel: "/repo",
        files: [],
      },
    });

    expect(registration?.info).toEqual({
      inputKind: "git",
      title: "repo working tree",
      sourceLabel: "/repo",
      files: [],
    });
  });
});
