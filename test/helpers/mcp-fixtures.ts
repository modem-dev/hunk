import type {
  HunkSessionRegistration,
  HunkSessionSnapshot,
  ListedSession,
  SelectedSessionContext,
  SessionFileSummary,
  SessionLiveCommentSummary,
} from "../../src/mcp/types";

export function createTestSessionFileSummary(
  overrides: Partial<SessionFileSummary> = {},
): SessionFileSummary {
  return {
    id: "file-1",
    path: "src/example.ts",
    additions: 1,
    deletions: 1,
    hunkCount: 1,
    ...overrides,
  };
}

export function createTestSessionSnapshot(
  overrides: Partial<HunkSessionSnapshot> = {},
): HunkSessionSnapshot {
  return {
    selectedFileId: "file-1",
    selectedFilePath: "src/example.ts",
    selectedHunkIndex: 0,
    showAgentNotes: false,
    liveCommentCount: 0,
    liveComments: [],
    updatedAt: "2026-03-22T00:00:00.000Z",
    ...overrides,
  };
}

export function createTestSessionRegistration(
  overrides: Partial<HunkSessionRegistration> = {},
): HunkSessionRegistration {
  return {
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    repoRoot: "/repo",
    inputKind: "git",
    title: "repo working tree",
    sourceLabel: "/repo",
    launchedAt: "2026-03-22T00:00:00.000Z",
    files: [createTestSessionFileSummary()],
    ...overrides,
  };
}

export function createTestListedSession(overrides: Partial<ListedSession> = {}): ListedSession {
  return {
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    repoRoot: "/repo",
    inputKind: "git",
    title: "repo working tree",
    sourceLabel: "/repo",
    launchedAt: "2026-03-22T00:00:00.000Z",
    fileCount: 1,
    files: [createTestSessionFileSummary()],
    snapshot: createTestSessionSnapshot(),
    ...overrides,
  };
}

export function createTestSessionLiveComment(
  overrides: Partial<SessionLiveCommentSummary> = {},
): SessionLiveCommentSummary {
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

export function createTestSelectedSessionContext(
  overrides: Partial<SelectedSessionContext> = {},
): SelectedSessionContext {
  return {
    sessionId: "session-1",
    title: "repo diff",
    sourceLabel: "/repo",
    repoRoot: "/repo",
    inputKind: "diff",
    selectedFile: createTestSessionFileSummary({
      additions: 1,
      deletions: 0,
      path: "README.md",
    }),
    selectedHunk: {
      index: 0,
      oldRange: [1, 1],
      newRange: [1, 2],
    },
    showAgentNotes: false,
    liveCommentCount: 0,
    ...overrides,
  };
}
