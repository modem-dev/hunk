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
    info: {
      inputKind: "vcs",
      title: "repo working tree",
      sourceLabel: "/repo",
      files,
    },
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
  test("snapshot rejects malformed comment summaries instead of partially filtering them", () => {
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

    expect(snapshot).toBeNull();
  });

  test("snapshot carries the live note markup width and rejects invalid values", () => {
    const parse = (noteMarkupWidth: unknown) =>
      parseSessionSnapshot({
        updatedAt: "2026-03-22T00:00:00.000Z",
        state: {
          selectedHunkIndex: 0,
          showAgentNotes: true,
          noteMarkupWidth,
          liveComments: [],
        },
      });

    expect(parse(112)?.state.noteMarkupWidth).toBe(112);
    expect(parse("wide")).toBeNull();
    expect(parse(undefined)?.state.noteMarkupWidth).toBeUndefined();
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
      experimentalFeatures: [],
      files: [],
    });
  });

  test("registration accepts absent metadata and exact bounded delegated review descriptors", () => {
    const absent = parseSessionRegistration(createRegistration([]));
    expect(absent?.info.review).toBeUndefined();

    const review = {
      kind: "change-request" as const,
      provider: "GitHub",
      title: "Review broker metadata",
      id: "#123",
      repository: "modem-dev/hunk",
      state: "open" as const,
    };
    const registration = createRegistration([]);
    const input = { ...registration, info: { ...registration.info, review } };
    expect(parseSessionRegistration(input)?.info.review).toEqual(review);

    for (const review of [
      { ...input.info.review, unknown: true },
      { ...input.info.review, title: "x".repeat(2 * 1024 + 1) },
      { ...input.info.review, title: "bad\u001b[31m" },
      { ...input.info.review, url: "http://github.com/modem-dev/hunk/pull/123" },
    ]) {
      expect(parseSessionRegistration({ ...input, info: { ...input.info, review } })).toBeNull();
    }
  });

  test("registration rejects malformed or unknown experimental feature ids", () => {
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
        experimentalFeatures: ["stml", "future-feature", "stml", 42],
        files: [],
      },
    });

    expect(registration).toBeNull();
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

  test("accepts legacy embedded patches beyond the generic string ceiling through the exact cap", () => {
    for (const size of [4_097, MAX_REGISTRATION_PATCH_BYTES]) {
      const patch = "x".repeat(size);
      expect(
        parseSessionRegistration(createRegistration([createFile({ patch })]))?.info.files[0]?.patch,
      ).toHaveLength(size);
    }
  });

  test("rejects a legacy embedded patch one byte beyond its cap", () => {
    const patch = "x".repeat(MAX_REGISTRATION_PATCH_BYTES + 1);

    expect(parseSessionRegistration(createRegistration([createFile({ patch })]))).toBeNull();
  });

  test("accepts zero-based pure-add, pure-delete, and new-file hunk ranges", () => {
    const ranges: Array<{
      oldRange: [number, number];
      newRange: [number, number];
    }> = [
      { oldRange: [0, 0], newRange: [1, 3] },
      { oldRange: [4, 2], newRange: [0, 0] },
      { oldRange: [0, 0], newRange: [0, 4] },
    ];
    const files = ranges.map((range, index) =>
      createFile({
        id: `file-${index}`,
        path: `src/file-${index}.ts`,
        hunks: [{ index: 0, header: "@@", ...range }],
      }),
    );

    expect(
      parseSessionRegistration(createRegistration(files))?.info.files.map((file) => file.hunks[0]),
    ).toEqual(ranges.map((range) => ({ index: 0, header: "@@", ...range })));
  });

  test("accepts zero-based selected ranges and review-note ranges in snapshots", () => {
    const snapshot = parseSessionSnapshot({
      updatedAt: "2026-03-22T00:00:00.000Z",
      state: {
        selectedHunkIndex: 0,
        selectedHunkOldRange: [0, 0],
        selectedHunkNewRange: [0, 3],
        showAgentNotes: true,
        liveComments: [],
        reviewNotes: [
          {
            noteId: "note-1",
            parentId: "note-root",
            source: "user",
            filePath: "new-file.ts",
            oldRange: [0, 0],
            newRange: [0, 3],
            body: "New file",
            createdAt: "2026-03-22T00:00:00.000Z",
          },
        ],
      },
    });

    expect(snapshot?.state).toMatchObject({
      selectedHunkOldRange: [0, 0],
      selectedHunkNewRange: [0, 3],
      reviewNotes: [{ parentId: "note-root", oldRange: [0, 0], newRange: [0, 3] }],
    });
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
      state: {
        selectedHunkIndex: 0,
        showAgentNotes: true,
        liveComments: [],
        reviewNotes,
      },
    });

    expect(snapshot).toBeNull();
  });
});
