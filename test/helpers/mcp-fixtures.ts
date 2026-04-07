import type {
  HunkSessionRegistration,
  HunkSessionSnapshot,
  ListedSession,
  SelectedSessionContext,
  SessionFileSummary,
  SessionLiveCommentSummary,
  SessionReview,
  SessionReviewFile,
  SessionReviewHunk,
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

export function createTestSessionReviewHunk(
  overrides: Partial<SessionReviewHunk> = {},
): SessionReviewHunk {
  return {
    index: 0,
    header: "@@ -1,1 +1,1 @@",
    oldRange: [1, 1],
    newRange: [1, 1],
    ...overrides,
  };
}

export function createTestSessionReviewFile(
  overrides: Partial<SessionReviewFile> = {},
): SessionReviewFile {
  return {
    ...createTestSessionFileSummary(overrides),
    patch: "@@ -1,1 +1,1 @@",
    hunks: [createTestSessionReviewHunk()],
    ...overrides,
  };
}

function summarizeReviewFile(reviewFile: SessionReviewFile): SessionFileSummary {
  const { patch: _patch, hunks: _hunks, ...summary } = reviewFile;
  return summary;
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
  const reviewFiles = overrides.reviewFiles ?? [createTestSessionReviewFile()];

  return {
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    repoRoot: "/repo",
    inputKind: "git",
    title: "repo working tree",
    sourceLabel: "/repo",
    launchedAt: "2026-03-22T00:00:00.000Z",
    ...overrides,
    reviewFiles,
  };
}

export function createTestListedSession(overrides: Partial<ListedSession> = {}): ListedSession {
  const files = overrides.files ?? [createTestSessionFileSummary()];
  const snapshot = overrides.snapshot ?? createTestSessionSnapshot();

  return {
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    repoRoot: "/repo",
    inputKind: "git",
    title: "repo working tree",
    sourceLabel: "/repo",
    launchedAt: "2026-03-22T00:00:00.000Z",
    ...overrides,
    fileCount: overrides.fileCount ?? files.length,
    files,
    snapshot,
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

export function createTestSessionReview(overrides: Partial<SessionReview> = {}): SessionReview {
  const files = overrides.files ?? [createTestSessionReviewFile()];
  const selectedFile =
    overrides.selectedFile === undefined ? (files[0] ?? null) : overrides.selectedFile;
  const selectedHunk =
    overrides.selectedHunk === undefined
      ? (selectedFile?.hunks[0] ?? null)
      : overrides.selectedHunk;

  return {
    sessionId: "session-1",
    title: "repo working tree",
    sourceLabel: "/repo",
    repoRoot: "/repo",
    inputKind: "git",
    showAgentNotes: false,
    liveCommentCount: 0,
    ...overrides,
    selectedFile,
    selectedHunk,
    files,
  };
}

export function createTestListedSessionFromReviewFiles(
  reviewFiles: SessionReviewFile[],
  overrides: Partial<ListedSession> = {},
): ListedSession {
  return createTestListedSession({
    fileCount: reviewFiles.length,
    files: reviewFiles.map(summarizeReviewFile),
    ...overrides,
  });
}
