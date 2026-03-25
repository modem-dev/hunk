import { describe, expect, test } from "bun:test";
import { HunkDaemonState, resolveSessionTarget } from "../src/mcp/daemonState";
import type {
  AppliedCommentResult,
  ClearedCommentsResult,
  HunkSessionRegistration,
  HunkSessionSnapshot,
  ListedSession,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  RemovedCommentResult,
  SessionLiveCommentSummary,
} from "../src/mcp/types";

function createListedSession(overrides: Partial<ListedSession> = {}): ListedSession {
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
    files: [
      {
        id: "file-1",
        path: "src/example.ts",
        additions: 1,
        deletions: 1,
        hunkCount: 1,
      },
    ],
    snapshot: {
      selectedFileId: "file-1",
      selectedFilePath: "src/example.ts",
      selectedHunkIndex: 0,
      showAgentNotes: false,
      liveCommentCount: 0,
      liveComments: [],
      updatedAt: "2026-03-22T00:00:00.000Z",
    },
    ...overrides,
  };
}

function createRegistration(
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
    files: [
      {
        id: "file-1",
        path: "src/example.ts",
        additions: 1,
        deletions: 1,
        hunkCount: 1,
      },
    ],
    ...overrides,
  };
}

function createSnapshot(overrides: Partial<HunkSessionSnapshot> = {}): HunkSessionSnapshot {
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

function createLiveComment(
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

describe("Hunk MCP daemon state", () => {
  test("resolves one target session by session id, session path, repo root, or sole-session fallback", () => {
    const one = [createListedSession()];
    const two = [
      createListedSession(),
      createListedSession({
        sessionId: "session-2",
        cwd: "/other-session",
        repoRoot: "/repo",
        snapshot: { ...createSnapshot(), updatedAt: "2026-03-22T00:00:01.000Z" },
      }),
    ];

    expect(resolveSessionTarget(one, {}).sessionId).toBe("session-1");
    expect(resolveSessionTarget(one, { sessionPath: "/repo" }).sessionId).toBe("session-1");
    expect(resolveSessionTarget(one, { repoRoot: "/repo" }).sessionId).toBe("session-1");
    expect(resolveSessionTarget(two, { sessionId: "session-2" }).sessionId).toBe("session-2");
    expect(() => resolveSessionTarget(two, {})).toThrow(
      "specify sessionId, sessionPath, or repoRoot",
    );
    expect(() => resolveSessionTarget(two, { repoRoot: "/repo" })).toThrow(
      "specify sessionId instead",
    );
  });

  test("keeps session-path matching tied to the live session cwd", () => {
    const sessions = [
      createListedSession({
        sessionId: "session-f",
        cwd: "/live-session",
        repoRoot: "/source-f",
      }),
      createListedSession({
        sessionId: "session-a",
        cwd: "/other-session",
        repoRoot: "/source-a",
      }),
    ];

    expect(resolveSessionTarget(sessions, { sessionPath: "/live-session" }).sessionId).toBe(
      "session-f",
    );
    expect(resolveSessionTarget(sessions, { repoRoot: "/source-a" }).sessionId).toBe("session-a");
  });

  test("exposes the selected session context from snapshot state", () => {
    const state = new HunkDaemonState();
    const socket = {
      send() {},
    };

    state.registerSession(
      socket,
      createRegistration(),
      createSnapshot({
        selectedHunkIndex: 1,
        selectedHunkOldRange: [8, 8],
        selectedHunkNewRange: [8, 8],
      }),
    );

    expect(state.getSelectedContext({ sessionId: "session-1" })).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        selectedFile: expect.objectContaining({ path: "src/example.ts" }),
        selectedHunk: expect.objectContaining({
          index: 1,
          oldRange: [8, 8],
          newRange: [8, 8],
        }),
      }),
    );
  });

  test("lists live comments from snapshot state and can filter by file", () => {
    const state = new HunkDaemonState();
    const socket = {
      send() {},
    };

    state.registerSession(
      socket,
      createRegistration(),
      createSnapshot({
        liveCommentCount: 2,
        liveComments: [
          createLiveComment(),
          createLiveComment({
            commentId: "comment-2",
            filePath: "src/other.ts",
            line: 9,
            summary: "Other",
          }),
        ],
      }),
    );

    expect(state.listComments({ sessionId: "session-1" })).toHaveLength(2);
    expect(state.listComments({ sessionId: "session-1" }, { filePath: "src/example.ts" })).toEqual([
      expect.objectContaining({ commentId: "comment-1" }),
    ]);
  });

  test("routes a comment command to the live session and resolves the async result", async () => {
    const state = new HunkDaemonState();
    const sent: string[] = [];
    const socket = {
      send(data: string) {
        sent.push(data);
      },
    };

    state.registerSession(socket, createRegistration(), createSnapshot());

    const pending = state.sendComment({
      sessionId: "session-1",
      filePath: "src/example.ts",
      side: "new",
      line: 4,
      summary: "Review note",
      reveal: true,
    });

    expect(sent).toHaveLength(1);
    const outgoing = JSON.parse(sent[0]!) as {
      requestId: string;
    };

    const result: AppliedCommentResult = {
      commentId: "comment-1",
      fileId: "file-1",
      filePath: "src/example.ts",
      hunkIndex: 0,
      side: "new",
      line: 4,
    };

    state.handleCommandResult({
      requestId: outgoing.requestId,
      ok: true,
      result,
    });

    await expect(pending).resolves.toEqual(result);
  });

  test("routes navigation commands to the live session and resolves the async result", async () => {
    const state = new HunkDaemonState();
    const sent: string[] = [];
    const socket = {
      send(data: string) {
        sent.push(data);
      },
    };

    state.registerSession(socket, createRegistration(), createSnapshot());

    const pending = state.sendNavigateToHunk({
      sessionId: "session-1",
      filePath: "src/example.ts",
      hunkIndex: 0,
    });

    expect(sent).toHaveLength(1);
    const outgoing = JSON.parse(sent[0]!) as {
      requestId: string;
      command: string;
    };
    expect(outgoing.command).toBe("navigate_to_hunk");

    const result: NavigatedSelectionResult = {
      fileId: "file-1",
      filePath: "src/example.ts",
      hunkIndex: 0,
      selectedHunk: {
        index: 0,
        oldRange: [1, 2],
        newRange: [1, 4],
      },
    };

    state.handleCommandResult({
      requestId: outgoing.requestId,
      ok: true,
      result,
    });

    await expect(pending).resolves.toEqual(result);
  });

  test("routes reload commands to the live session and resolves the async result", async () => {
    const state = new HunkDaemonState();
    const sent: string[] = [];
    const socket = {
      send(data: string) {
        sent.push(data);
      },
    };

    state.registerSession(socket, createRegistration(), createSnapshot());

    const pending = state.sendReloadSession({
      sessionId: "session-1",
      nextInput: {
        kind: "show",
        ref: "HEAD~1",
        options: {},
      },
    });

    expect(sent).toHaveLength(1);
    const outgoing = JSON.parse(sent[0]!) as {
      requestId: string;
      command: string;
      input: { nextInput: { kind: string; ref?: string; options?: Record<string, unknown> } };
    };
    expect(outgoing.command).toBe("reload_session");
    expect(outgoing.input.nextInput).toEqual({
      kind: "show",
      ref: "HEAD~1",
      options: {},
    });

    const result: ReloadedSessionResult = {
      sessionId: "session-1",
      inputKind: "show",
      title: "repo show HEAD~1",
      sourceLabel: "/repo",
      fileCount: 1,
      selectedFilePath: "src/example.ts",
      selectedHunkIndex: 0,
    };

    state.handleCommandResult({
      requestId: outgoing.requestId,
      ok: true,
      result,
    });

    await expect(pending).resolves.toEqual(result);
  });

  test("routes remove-comment commands to the live session and resolves the async result", async () => {
    const state = new HunkDaemonState();
    const sent: string[] = [];
    const socket = {
      send(data: string) {
        sent.push(data);
      },
    };

    state.registerSession(socket, createRegistration(), createSnapshot());

    const pending = state.sendRemoveComment({
      sessionId: "session-1",
      commentId: "comment-1",
    });

    expect(sent).toHaveLength(1);
    const outgoing = JSON.parse(sent[0]!) as {
      requestId: string;
      command: string;
    };
    expect(outgoing.command).toBe("remove_comment");

    const result: RemovedCommentResult = {
      commentId: "comment-1",
      removed: true,
      remainingCommentCount: 0,
    };

    state.handleCommandResult({
      requestId: outgoing.requestId,
      ok: true,
      result,
    });

    await expect(pending).resolves.toEqual(result);
  });

  test("routes clear-comments commands to the live session and resolves the async result", async () => {
    const state = new HunkDaemonState();
    const sent: string[] = [];
    const socket = {
      send(data: string) {
        sent.push(data);
      },
    };

    state.registerSession(socket, createRegistration(), createSnapshot());

    const pending = state.sendClearComments({
      sessionId: "session-1",
      filePath: "src/example.ts",
    });

    expect(sent).toHaveLength(1);
    const outgoing = JSON.parse(sent[0]!) as {
      requestId: string;
      command: string;
    };
    expect(outgoing.command).toBe("clear_comments");

    const result: ClearedCommentsResult = {
      removedCount: 2,
      remainingCommentCount: 0,
      filePath: "src/example.ts",
    };

    state.handleCommandResult({
      requestId: outgoing.requestId,
      ok: true,
      result,
    });

    await expect(pending).resolves.toEqual(result);
  });

  test("rejects in-flight commands when the session disconnects", async () => {
    const state = new HunkDaemonState();
    const socket = {
      send() {},
    };

    state.registerSession(socket, createRegistration(), createSnapshot());
    const pending = state.sendComment({
      sessionId: "session-1",
      filePath: "src/example.ts",
      side: "new",
      line: 4,
      summary: "Review note",
    });

    state.unregisterSocket(socket);

    await expect(pending).rejects.toThrow("disconnected");
  });

  test("rejects in-flight commands when a session reconnects on a new socket", async () => {
    const state = new HunkDaemonState();
    const originalSocket = {
      send() {},
    };
    const replacementSocket = {
      send() {},
    };

    state.registerSession(originalSocket, createRegistration(), createSnapshot());
    const pending = state.sendComment({
      sessionId: "session-1",
      filePath: "src/example.ts",
      side: "new",
      line: 4,
      summary: "Review note",
    });

    state.registerSession(
      replacementSocket,
      createRegistration(),
      createSnapshot({ updatedAt: "2026-03-22T00:00:01.000Z" }),
    );

    await expect(pending).rejects.toThrow("reconnected before the command completed");
    expect(state.listSessions()).toHaveLength(1);
  });

  test("rejects commands immediately when the live session socket cannot accept them", async () => {
    const state = new HunkDaemonState();
    const socket = {
      send() {
        throw new Error("socket closed");
      },
    };

    state.registerSession(socket, createRegistration(), createSnapshot());

    await expect(
      state.sendComment({
        sessionId: "session-1",
        filePath: "src/example.ts",
        side: "new",
        line: 4,
        summary: "Review note",
      }),
    ).rejects.toThrow("socket closed");
    expect(state.getPendingCommandCount()).toBe(0);
  });

  test("prunes stale sessions and rejects their in-flight commands", async () => {
    const state = new HunkDaemonState();
    const sent: string[] = [];
    const socket = {
      send(data: string) {
        sent.push(data);
      },
    };

    state.registerSession(socket, createRegistration(), createSnapshot());
    const pending = state.sendComment({
      sessionId: "session-1",
      filePath: "src/example.ts",
      side: "new",
      line: 4,
      summary: "Review note",
    });

    expect(sent).toHaveLength(1);
    const removed = state.pruneStaleSessions({
      ttlMs: 1,
      now: Date.now() + 10,
    });

    expect(removed).toBe(1);
    expect(state.listSessions()).toHaveLength(0);
    await expect(pending).rejects.toThrow("stale");
  });

  test("heartbeats keep an otherwise idle session from being pruned", () => {
    const state = new HunkDaemonState();
    const socket = {
      send() {},
    };

    state.registerSession(socket, createRegistration(), createSnapshot());
    const registeredAt = Date.now();

    expect(
      state.pruneStaleSessions({
        ttlMs: 50,
        now: registeredAt + 25,
      }),
    ).toBe(0);

    state.markSessionSeen("session-1");

    expect(
      state.pruneStaleSessions({
        ttlMs: 50,
        now: Date.now() + 25,
      }),
    ).toBe(0);
    expect(state.listSessions()).toHaveLength(1);
  });
});
