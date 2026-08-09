import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import { reviewDigest } from "../../src/core/review/identity";
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
} from "../../src/session/types";

export function createTestSessionFileSummary(
  overrides: Partial<SessionFileSummary> = {},
): SessionFileSummary {
  return {
    id: "file-1",
    path: "src/example.ts",
    additions: 1,
    deletions: 1,
    hunkCount: 1,
    flags: { untracked: false, binary: false, tooLarge: false, partial: false },
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
  overrides: Partial<HunkSessionSnapshot["state"]> & { updatedAt?: string } = {},
): HunkSessionSnapshot {
  const { updatedAt = "2026-03-22T00:00:00.000Z", ...stateOverrides } = overrides;

  return {
    updatedAt,
    state: {
      documentGeneration: "generation:test",
      stateRevision: 0,
      review: {
        documentGeneration: "generation:test",
        stateRevision: 0,
        selection: { fileKey: "file-key-1", hunkIndex: 0 },
        filter: "",
        showAgentNotes: false,
        notes: [],
      },
      selectedFileId: "file-1",
      selectedFilePath: "src/example.ts",
      selectedHunkIndex: 0,
      selectedHunkOldRange: [1, 1],
      selectedHunkNewRange: [1, 1],
      showAgentNotes: false,
      liveCommentCount: 0,
      liveComments: [],
      reviewNoteCount: 0,
      reviewNotes: [],
      ...stateOverrides,
    },
  };
}

export function createTestSessionRegistration(
  overrides: Partial<HunkSessionRegistration> &
    Partial<
      Pick<
        HunkSessionRegistration["info"],
        "inputKind" | "title" | "sourceLabel" | "experimentalFeatures" | "files"
      >
    > & {
      info?: Partial<HunkSessionRegistration["info"]>;
    } = {},
): HunkSessionRegistration {
  const {
    inputKind,
    title,
    sourceLabel,
    experimentalFeatures,
    files,
    info: infoOverrides,
    ...registrationOverrides
  } = overrides;
  const resolvedFiles = files ?? infoOverrides?.files ?? [createTestSessionReviewFile()];
  const generation = infoOverrides?.documentGeneration ?? "generation:test";
  const registrationFiles = resolvedFiles.map(({ patch: _patch, ...file }) => ({
    ...file,
    hunkCount: file.hunks.length,
    flags: file.flags ?? { untracked: false, binary: false, tooLarge: false, partial: false },
  }));
  const patchResources = resolvedFiles.map((file, index) => {
    const patch = file.patch ?? "";
    return {
      id: `resource:test:${index}`,
      kind: "patch" as const,
      generation,
      fileKey: `file-key-${index + 1}`,
      contentType: "text/x-diff; charset=utf-8" as const,
      byteLength: new TextEncoder().encode(patch).byteLength,
      digest: reviewDigest(patch),
    };
  });
  const canonicalResources = resolvedFiles.map((_file, index) => {
    const content = "{}";
    return {
      id: `resource:canonical:test:${index}`,
      kind: "canonical-file" as const,
      generation,
      fileKey: `file-key-${index + 1}`,
      contentType: "application/vnd.hunk.review-file+json; charset=utf-8" as const,
      byteLength: new TextEncoder().encode(content).byteLength,
      digest: reviewDigest(content),
    };
  });
  const resources = [...patchResources, ...canonicalResources];

  return {
    registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
    sessionId: "session-1",
    pid: 123,
    cwd: "/repo",
    repoRoot: "/repo",
    launchedAt: "2026-03-22T00:00:00.000Z",
    ...registrationOverrides,
    info: {
      inputKind: inputKind ?? infoOverrides?.inputKind ?? "vcs",
      title: title ?? infoOverrides?.title ?? "repo working tree",
      sourceLabel: sourceLabel ?? infoOverrides?.sourceLabel ?? "/repo",
      experimentalFeatures: experimentalFeatures ?? infoOverrides?.experimentalFeatures ?? [],
      documentGeneration: generation,
      reviewManifest: infoOverrides?.reviewManifest ?? {
        version: 1,
        generation,
        documentIdentity: "review:test",
        changesetId: "changeset:test",
        title: title ?? infoOverrides?.title ?? "repo working tree",
        sourceLabel: sourceLabel ?? infoOverrides?.sourceLabel ?? "/repo",
        files: registrationFiles.map((file, index) => ({
          key: `file-key-${index + 1}`,
          runtimeId: file.id,
          path: file.path,
          ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
          changeKind: file.previousPath ? "rename-changed" : "change",
          additions: file.additions,
          deletions: file.deletions,
          statsTruncated: false,
          hunkCount: file.hunks.length,
          flags: {
            untracked: file.flags?.untracked ?? false,
            binary: file.flags?.binary ?? false,
            tooLarge: file.flags?.tooLarge ?? false,
            partial: file.flags?.partial ?? false,
          },
          patchResourceId: patchResources[index]!.id,
          canonicalResourceId: canonicalResources[index]!.id,
          sourceResourceIds: {},
          hunks: file.hunks,
          notes: [],
        })),
        resources,
        capabilities: {
          actions: ["selection/select", "selection/set-line", "filter/set", "notes/set-visibility"],
        },
      },
      files: registrationFiles,
    },
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
    launchedAt: "2026-03-22T00:00:00.000Z",
    inputKind: "vcs",
    title: "repo working tree",
    sourceLabel: "/repo",
    experimentalFeatures: [],
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
    experimentalFeatures: [],
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
    inputKind: "vcs",
    experimentalFeatures: [],
    showAgentNotes: false,
    liveCommentCount: 0,
    ...overrides,
    selectedFile,
    selectedHunk,
    files,
  };
}

export function createTestListedSessionFromReviewFiles(
  files: SessionReviewFile[],
  overrides: Partial<ListedSession> = {},
): ListedSession {
  return createTestListedSession({
    fileCount: files.length,
    files: files.map(summarizeReviewFile),
    ...overrides,
  });
}
