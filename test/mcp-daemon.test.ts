import { describe, expect, test } from "bun:test";
import { HunkDaemonState, resolveSessionTarget } from "../src/mcp/daemonState";
import type { AppliedCommentResult, HunkSessionRegistration, HunkSessionSnapshot, ListedSession } from "../src/mcp/types";

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
      updatedAt: "2026-03-22T00:00:00.000Z",
    },
    ...overrides,
  };
}

function createRegistration(): HunkSessionRegistration {
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
  };
}

function createSnapshot(): HunkSessionSnapshot {
  return {
    selectedFileId: "file-1",
    selectedFilePath: "src/example.ts",
    selectedHunkIndex: 0,
    showAgentNotes: false,
    liveCommentCount: 0,
    updatedAt: "2026-03-22T00:00:00.000Z",
  };
}

describe("Hunk MCP daemon state", () => {
  test("resolves one target session by session id, repo root, or sole-session fallback", () => {
    const one = [createListedSession()];
    const two = [createListedSession(), createListedSession({ sessionId: "session-2", snapshot: { ...createSnapshot(), updatedAt: "2026-03-22T00:00:01.000Z" } })];

    expect(resolveSessionTarget(one, {}).sessionId).toBe("session-1");
    expect(resolveSessionTarget(one, { repoRoot: "/repo" }).sessionId).toBe("session-1");
    expect(resolveSessionTarget(two, { sessionId: "session-2" }).sessionId).toBe("session-2");
    expect(() => resolveSessionTarget(two, {})).toThrow("specify sessionId or repoRoot");
    expect(() => resolveSessionTarget(two, { repoRoot: "/repo" })).toThrow("specify sessionId instead");
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
});
