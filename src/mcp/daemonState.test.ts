import { describe, expect, test } from "bun:test";
import {
  createTestListedSession,
  createTestSessionLiveComment,
  createTestSessionRegistration,
  createTestSessionSnapshot,
} from "../../test/helpers/mcp-fixtures";
import { HunkDaemonState, resolveSessionTarget } from "./daemonState";
import type {
  AppliedCommentBatchResult,
  AppliedCommentResult,
  ClearedCommentsResult,
  NavigatedSelectionResult,
  ReloadedSessionResult,
  RemovedCommentResult,
} from "./types";

function createRegistration(overrides = {}) {
  return createTestSessionRegistration(overrides);
}

function createSnapshot(overrides = {}) {
  return createTestSessionSnapshot(overrides);
}

function createLiveComment(overrides = {}) {
  return createTestSessionLiveComment(overrides);
}

describe("Hunk MCP daemon state", () => {
  test("resolves one target session by session id, session path, repo root, or sole-session fallback", () => {
    const one = [createTestListedSession()];
    const two = [
      createTestListedSession(),
      createTestListedSession({
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
      createTestListedSession({
        sessionId: "session-f",
        cwd: "/live-session",
        repoRoot: "/source-f",
      }),
      createTestListedSession({
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

  test("exports review structure without raw patch text by default", () => {
    const state = new HunkDaemonState();
    const socket = {
      send() {},
    };

    state.registerSession(
      socket,
      createRegistration(),
      createSnapshot({
        selectedHunkIndex: 0,
        selectedHunkOldRange: [1, 1],
        selectedHunkNewRange: [1, 1],
      }),
    );

    expect(state.getSessionReview({ sessionId: "session-1" })).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        selectedFile: expect.objectContaining({ path: "src/example.ts" }),
        selectedHunk: expect.objectContaining({
          index: 0,
          header: "@@ -1,1 +1,1 @@",
        }),
        files: [
          expect.objectContaining({
            path: "src/example.ts",
          }),
        ],
      }),
    );
    expect(state.getSessionReview({ sessionId: "session-1" }).files[0]).not.toHaveProperty("patch");
  });

  test("exports raw patch text when review requests includePatch", () => {
    const state = new HunkDaemonState();
    const socket = {
      send() {},
    };

    state.registerSession(
      socket,
      createRegistration(),
      createSnapshot({
        selectedHunkIndex: 0,
        selectedHunkOldRange: [1, 1],
        selectedHunkNewRange: [1, 1],
      }),
    );

    expect(state.getSessionReview({ sessionId: "session-1" }, { includePatch: true })).toEqual(
      expect.objectContaining({
        files: [
          expect.objectContaining({
            path: "src/example.ts",
            patch: "@@ -1,1 +1,1 @@",
          }),
        ],
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

  test("ignores incompatible session registrations so listings stay usable after upgrades", () => {
    const state = new HunkDaemonState();
    const socket = {
      send() {},
    };

    const accepted = state.registerSession(
      socket,
      {
        ...createRegistration(),
        registrationVersion: 0,
      },
      createSnapshot(),
    );

    expect(accepted).toBe(false);
    expect(state.listSessions()).toEqual([]);
  });

  test("reports invalid snapshot updates without replacing the last valid selection", () => {
    const state = new HunkDaemonState();
    const socket = {
      send() {},
    };

    state.registerSession(socket, createRegistration(), createSnapshot());

    const result = state.updateSnapshot("session-1", {
      selectedHunkIndex: "oops",
    });

    expect(result).toBe("invalid");
    expect(state.getSelectedContext({ sessionId: "session-1" })).toEqual(
      expect.objectContaining({
        selectedHunk: expect.objectContaining({ index: 0 }),
      }),
    );
  });

  test("reports missing sessions separately from invalid snapshot payloads", () => {
    const state = new HunkDaemonState();

    expect(
      state.updateSnapshot("missing-session", {
        selectedHunkIndex: 0,
      }),
    ).toBe("not-found");
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

  test("routes comment-batch commands to the live session and resolves the async result", async () => {
    const state = new HunkDaemonState();
    const sent: string[] = [];
    const socket = {
      send(data: string) {
        sent.push(data);
      },
    };

    state.registerSession(socket, createRegistration(), createSnapshot());

    const pending = state.sendCommentBatch({
      sessionId: "session-1",
      comments: [
        {
          filePath: "src/example.ts",
          hunkIndex: 0,
          summary: "Review note 1",
        },
        {
          filePath: "src/example.ts",
          hunkIndex: 0,
          summary: "Review note 2",
        },
      ],
      revealMode: "none",
    });

    expect(sent).toHaveLength(1);
    const outgoing = JSON.parse(sent[0]!) as {
      requestId: string;
      command: string;
    };
    expect(outgoing.command).toBe("comment_batch");

    const result: AppliedCommentBatchResult = {
      applied: [
        {
          commentId: "comment-1",
          fileId: "file-1",
          filePath: "src/example.ts",
          hunkIndex: 0,
          side: "new",
          line: 4,
        },
        {
          commentId: "comment-2",
          fileId: "file-1",
          filePath: "src/example.ts",
          hunkIndex: 0,
          side: "new",
          line: 9,
        },
      ],
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
