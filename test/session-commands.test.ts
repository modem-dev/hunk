import { afterEach, describe, expect, test } from "bun:test";
import type { SessionCommandInput, SessionSelectorInput } from "../src/core/types";
import { runSessionCommand, setSessionCommandTestHooks, type HunkDaemonCliClient } from "../src/session/commands";

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
    connect: async () => undefined,
    close: async () => undefined,
    listToolNames: async () => new Set<string>(),
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
  test("refreshes an older Hunk daemon before running a newer context command", async () => {
    const selector: SessionSelectorInput = { sessionId: "session-1" };
    const restartCalls: Array<{ missingTools: string[]; selector?: SessionSelectorInput }> = [];
    const createdClients: string[] = [];

    const clients = [
      createClient({
        listToolNames: async () => {
          createdClients.push("stale-tools");
          return new Set(["list_sessions", "get_session", "comment"]);
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
      restartDaemonForMissingTools: async (missingTools, receivedSelector) => {
        restartCalls.push({ missingTools, selector: receivedSelector });
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
        missingTools: ["get_selected_context"],
        selector,
      },
    ]);
    expect(createdClients).toEqual(["stale-tools", "fresh-context"]);
  });

  test("throws a clear error when the daemon is missing tools but does not look like Hunk", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          listToolNames: async () => new Set(["list_sessions", "strange_tool"]),
        }),
      resolveDaemonAvailability: async () => true,
      restartDaemonForMissingTools: async () => {
        throw new Error("should not restart");
      },
    });

    await expect(
      runSessionCommand({
        kind: "session",
        action: "comment-list",
        selector: { sessionId: "session-1" },
        output: "json",
      } satisfies SessionCommandInput),
    ).rejects.toThrow("missing required tools (list_comments)");
  });
});
