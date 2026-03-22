import { afterEach, describe, expect, test } from "bun:test";
import type { SessionCommandInput, SessionSelectorInput } from "../src/core/types";
import {
  runSessionCommand,
  setSessionCommandTestHooks,
  type HunkDaemonCliClient,
} from "../src/session/commands";

function createListedSession(sessionId: string) {
  return {
    sessionId,
    pid: 123,
    cwd: "/repo",
    repoRoot: "/repo",
    inputKind: "diff" as const,
    title: "repo diff",
    sourceLabel: "/repo",
    launchedAt: "2026-03-22T00:00:00.000Z",
    fileCount: 1,
    files: [
      {
        id: "file-1",
        path: "README.md",
        additions: 1,
        deletions: 0,
        hunkCount: 1,
      },
    ],
    snapshot: {
      selectedFileId: "file-1",
      selectedFilePath: "README.md",
      selectedHunkIndex: 0,
      selectedHunkOldRange: [1, 1] as [number, number],
      selectedHunkNewRange: [1, 2] as [number, number],
      showAgentNotes: false,
      liveCommentCount: 0,
      liveComments: [],
      updatedAt: "2026-03-22T00:00:00.000Z",
    },
  };
}

function createClient(overrides: Partial<HunkDaemonCliClient>): HunkDaemonCliClient {
  return {
    getCapabilities: async () => ({
      version: 1,
      actions: [
        "list",
        "get",
        "context",
        "navigate",
        "comment-add",
        "comment-list",
        "comment-rm",
        "comment-clear",
      ],
    }),
    listSessions: async () => [],
    getSession: async () => createListedSession("session-1"),
    getSelectedContext: async () => ({
      sessionId: "session-1",
      title: "repo diff",
      sourceLabel: "/repo",
      repoRoot: "/repo",
      inputKind: "diff",
      selectedFile: {
        id: "file-1",
        path: "README.md",
        additions: 1,
        deletions: 0,
        hunkCount: 1,
      },
      selectedHunk: {
        index: 0,
        oldRange: [1, 1],
        newRange: [1, 2],
      },
      showAgentNotes: false,
      liveCommentCount: 0,
    }),
    navigateToHunk: async () => ({
      fileId: "file-1",
      filePath: "README.md",
      hunkIndex: 0,
    }),
    addComment: async () => ({
      commentId: "comment-1",
      fileId: "file-1",
      filePath: "README.md",
      hunkIndex: 0,
      side: "new",
      line: 1,
    }),
    listComments: async () => [],
    removeComment: async () => ({
      commentId: "comment-1",
      removed: true,
      remainingCommentCount: 0,
    }),
    clearComments: async () => ({
      removedCount: 0,
      remainingCommentCount: 0,
    }),
    ...overrides,
  };
}

afterEach(() => {
  setSessionCommandTestHooks(null);
});

describe("session command compatibility checks", () => {
  test("refreshes an older daemon without the session API before running context", async () => {
    const selector: SessionSelectorInput = { sessionId: "session-1" };
    const restartCalls: Array<{ action: string; selector?: SessionSelectorInput }> = [];
    const createdClients: string[] = [];

    const clients = [
      createClient({
        getCapabilities: async () => {
          createdClients.push("stale-capabilities");
          return null;
        },
      }),
      createClient({
        getSelectedContext: async (receivedSelector) => {
          createdClients.push("fresh-context");
          expect(receivedSelector).toEqual(selector);
          return {
            sessionId: "session-1",
            title: "repo diff",
            sourceLabel: "/repo",
            repoRoot: "/repo",
            inputKind: "diff",
            selectedFile: {
              id: "file-1",
              path: "README.md",
              additions: 1,
              deletions: 0,
              hunkCount: 1,
            },
            selectedHunk: {
              index: 0,
              oldRange: [1, 1],
              newRange: [1, 2],
            },
            showAgentNotes: false,
            liveCommentCount: 0,
          };
        },
      }),
    ];

    setSessionCommandTestHooks({
      createClient: () => {
        const client = clients.shift();
        if (!client) {
          throw new Error("No fake session client remaining.");
        }

        return client;
      },
      resolveDaemonAvailability: async () => true,
      restartDaemonForMissingAction: async (action, receivedSelector) => {
        restartCalls.push({ action, selector: receivedSelector });
      },
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "context",
      selector,
      output: "json",
    } satisfies SessionCommandInput);

    expect(JSON.parse(output)).toMatchObject({
      context: {
        sessionId: "session-1",
        selectedFile: {
          path: "README.md",
        },
        selectedHunk: {
          index: 0,
        },
      },
    });
    expect(restartCalls).toEqual([
      {
        action: "context",
        selector,
      },
    ]);
    expect(createdClients).toEqual(["stale-capabilities", "fresh-context"]);
  });

  test("does not restart when the daemon already exposes the needed session action", async () => {
    const restartCalls: string[] = [];

    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          getCapabilities: async () => ({
            version: 1,
            actions: [
              "list",
              "get",
              "context",
              "navigate",
              "comment-add",
              "comment-list",
              "comment-rm",
              "comment-clear",
            ],
          }),
        }),
      resolveDaemonAvailability: async () => true,
      restartDaemonForMissingAction: async (action) => {
        restartCalls.push(action);
      },
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "comment-list",
      selector: { sessionId: "session-1" },
      output: "json",
    } satisfies SessionCommandInput);

    expect(JSON.parse(output)).toEqual({ comments: [] });
    expect(restartCalls).toEqual([]);
  });
});
