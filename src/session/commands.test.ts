import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  createTestListedSession as buildTestListedSession,
  createTestSelectedSessionContext,
  createTestSessionFileSummary,
  createTestSessionReview as buildTestSessionReview,
  createTestSessionSnapshot,
} from "../../test/helpers/session-daemon-fixtures";
import type { SessionCommandInput, SessionSelectorInput } from "../core/types";
import {
  runSessionCommand,
  setSessionCommandTestHooks,
  type HunkDaemonCliClient,
} from "./commands";
import { HUNK_DAEMON_UPGRADE_RESTART_NOTICE } from "./capabilities";
import { HUNK_SESSION_API_VERSION, HUNK_SESSION_DAEMON_VERSION } from "./protocol";

function createTestListedSession(sessionId: string) {
  return buildTestListedSession({
    files: [createTestSessionFileSummary({ additions: 1, deletions: 0, path: "README.md" })],
    inputKind: "diff",
    sessionId,
    snapshot: createTestSessionSnapshot({
      selectedFilePath: "README.md",
      selectedHunkOldRange: [1, 1],
      selectedHunkNewRange: [1, 2],
    }),
    title: "repo diff",
  });
}

function createTestSessionReview(includePatch = false) {
  const patch = "@@ -1,1 +1,2 @@";
  const file = {
    ...createTestSessionFileSummary({ additions: 1, deletions: 0, path: "README.md" }),
    ...(includePatch ? { patch } : {}),
    hunks: [
      {
        index: 0,
        header: patch,
        oldRange: [1, 1] as [number, number],
        newRange: [1, 2] as [number, number],
      },
    ],
  };

  return buildTestSessionReview({
    files: [file],
    inputKind: "diff",
    selectedFile: file,
    selectedHunk: file.hunks[0]!,
    title: "repo diff",
  });
}

function createClient(overrides: Partial<HunkDaemonCliClient>): HunkDaemonCliClient {
  return {
    getCapabilities: async () => ({
      version: HUNK_SESSION_API_VERSION,
      daemonVersion: HUNK_SESSION_DAEMON_VERSION,
      actions: [
        "list",
        "get",
        "context",
        "review",
        "navigate",
        "reload",
        "comment-add",
        "comment-apply",
        "comment-list",
        "comment-rm",
        "comment-clear",
      ],
    }),
    listSessions: async () => [],
    getSession: async () => createTestListedSession("session-1"),
    getSelectedContext: async () => createTestSelectedSessionContext(),
    getSessionReview: async (input) => createTestSessionReview(input.includePatch),
    navigateToHunk: async () => ({
      fileId: "file-1",
      filePath: "README.md",
      hunkIndex: 0,
    }),
    reloadSession: async () => ({
      sessionId: "session-1",
      inputKind: "show",
      title: "repo show HEAD~1",
      sourceLabel: "/repo",
      fileCount: 1,
      selectedFilePath: "README.md",
      selectedHunkIndex: 0,
    }),
    addComment: async () => ({
      commentId: "comment-1",
      fileId: "file-1",
      filePath: "README.md",
      hunkIndex: 0,
      side: "new",
      line: 1,
    }),
    applyComments: async () => ({
      applied: [
        {
          commentId: "comment-1",
          fileId: "file-1",
          filePath: "README.md",
          hunkIndex: 0,
          side: "new",
          line: 1,
        },
      ],
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
    const notices: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      notices.push(args.map((value) => String(value)).join(" "));
    };

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
          return createTestSelectedSessionContext();
        },
      }),
    ];

    try {
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
      expect(notices).toContain(HUNK_DAEMON_UPGRADE_RESTART_NOTICE);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("refreshes an incompatible daemon version before running list", async () => {
    const restartCalls: Array<{ action: string; selector?: SessionSelectorInput }> = [];
    const createdClients: string[] = [];
    const notices: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      notices.push(args.map((value) => String(value)).join(" "));
    };

    const clients = [
      createClient({
        getCapabilities: async () => {
          createdClients.push("stale-capabilities");
          return {
            version: HUNK_SESSION_API_VERSION - 1,
            daemonVersion: HUNK_SESSION_DAEMON_VERSION,
            actions: ["list"],
          };
        },
      }),
      createClient({
        listSessions: async () => {
          createdClients.push("fresh-list");
          return [createTestListedSession("session-1")];
        },
      }),
    ];

    try {
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
        action: "list",
        output: "json",
      } satisfies SessionCommandInput);

      expect(JSON.parse(output)).toMatchObject({
        sessions: [
          {
            sessionId: "session-1",
          },
        ],
      });
      expect(restartCalls).toEqual([
        {
          action: "list",
          selector: undefined,
        },
      ]);
      expect(createdClients).toEqual(["stale-capabilities", "fresh-list"]);
      expect(notices).toContain(HUNK_DAEMON_UPGRADE_RESTART_NOTICE);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("refreshes a stale daemon before running comment-add", async () => {
    const selector: SessionSelectorInput = { sessionId: "session-1" };
    const restartCalls: Array<{ action: string; selector?: SessionSelectorInput }> = [];
    const createdClients: string[] = [];
    const notices: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      notices.push(args.map((value) => String(value)).join(" "));
    };

    const clients = [
      createClient({
        getCapabilities: async () => {
          createdClients.push("stale-capabilities");
          return null;
        },
      }),
      createClient({
        addComment: async (input) => {
          createdClients.push("fresh-comment-add");
          expect(input.selector).toEqual(selector);
          expect(input.filePath).toBe("README.md");
          expect(input.side).toBe("new");
          expect(input.line).toBe(2);
          expect(input.summary).toBe("Review note");
          return {
            commentId: "comment-1",
            fileId: "file-1",
            filePath: "README.md",
            hunkIndex: 0,
            side: "new",
            line: 2,
          };
        },
      }),
    ];

    try {
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
        action: "comment-add",
        selector,
        filePath: "README.md",
        side: "new",
        line: 2,
        summary: "Review note",
        reveal: false,
        output: "json",
      } satisfies SessionCommandInput);

      expect(JSON.parse(output)).toMatchObject({
        result: {
          commentId: "comment-1",
          filePath: "README.md",
          side: "new",
          line: 2,
        },
      });
      expect(restartCalls).toEqual([
        {
          action: "comment-add",
          selector,
        },
      ]);
      expect(createdClients).toEqual(["stale-capabilities", "fresh-comment-add"]);
      expect(notices).toContain(HUNK_DAEMON_UPGRADE_RESTART_NOTICE);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("runs review commands through the daemon without raw patch text by default", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          getSessionReview: async (input) => {
            expect(input.selector).toEqual({ sessionId: "session-1" });
            expect(input.includePatch).toBe(false);

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
                hunks: [
                  {
                    index: 0,
                    header: "@@ -1,1 +1,2 @@",
                    oldRange: [1, 1],
                    newRange: [1, 2],
                  },
                ],
              },
              selectedHunk: {
                index: 0,
                header: "@@ -1,1 +1,2 @@",
                oldRange: [1, 1],
                newRange: [1, 2],
              },
              showAgentNotes: false,
              liveCommentCount: 0,
              files: [
                {
                  id: "file-1",
                  path: "README.md",
                  additions: 1,
                  deletions: 0,
                  hunkCount: 1,
                  hunks: [
                    {
                      index: 0,
                      header: "@@ -1,1 +1,2 @@",
                      oldRange: [1, 1],
                      newRange: [1, 2],
                    },
                  ],
                },
              ],
            };
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "review",
      selector: { sessionId: "session-1" },
      output: "json",
      includePatch: false,
    } satisfies SessionCommandInput);

    expect(JSON.parse(output)).toEqual({
      review: {
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
          hunks: [
            {
              index: 0,
              header: "@@ -1,1 +1,2 @@",
              oldRange: [1, 1],
              newRange: [1, 2],
            },
          ],
        },
        selectedHunk: {
          index: 0,
          header: "@@ -1,1 +1,2 @@",
          oldRange: [1, 1],
          newRange: [1, 2],
        },
        showAgentNotes: false,
        liveCommentCount: 0,
        files: [
          {
            id: "file-1",
            path: "README.md",
            additions: 1,
            deletions: 0,
            hunkCount: 1,
            hunks: [
              {
                index: 0,
                header: "@@ -1,1 +1,2 @@",
                oldRange: [1, 1],
                newRange: [1, 2],
              },
            ],
          },
        ],
      },
    });
  });

  test("runs review commands through the daemon with raw patch text when requested", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          getSessionReview: async (input) => {
            expect(input.selector).toEqual({ sessionId: "session-1" });
            expect(input.includePatch).toBe(true);

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
                patch: "@@ -1,1 +1,2 @@",
                hunks: [
                  {
                    index: 0,
                    header: "@@ -1,1 +1,2 @@",
                    oldRange: [1, 1],
                    newRange: [1, 2],
                  },
                ],
              },
              selectedHunk: {
                index: 0,
                header: "@@ -1,1 +1,2 @@",
                oldRange: [1, 1],
                newRange: [1, 2],
              },
              showAgentNotes: false,
              liveCommentCount: 0,
              files: [
                {
                  id: "file-1",
                  path: "README.md",
                  additions: 1,
                  deletions: 0,
                  hunkCount: 1,
                  patch: "@@ -1,1 +1,2 @@",
                  hunks: [
                    {
                      index: 0,
                      header: "@@ -1,1 +1,2 @@",
                      oldRange: [1, 1],
                      newRange: [1, 2],
                    },
                  ],
                },
              ],
            };
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "review",
      selector: { sessionId: "session-1" },
      output: "json",
      includePatch: true,
    } satisfies SessionCommandInput);

    expect(JSON.parse(output)).toEqual({
      review: {
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
          patch: "@@ -1,1 +1,2 @@",
          hunks: [
            {
              index: 0,
              header: "@@ -1,1 +1,2 @@",
              oldRange: [1, 1],
              newRange: [1, 2],
            },
          ],
        },
        selectedHunk: {
          index: 0,
          header: "@@ -1,1 +1,2 @@",
          oldRange: [1, 1],
          newRange: [1, 2],
        },
        showAgentNotes: false,
        liveCommentCount: 0,
        files: [
          {
            id: "file-1",
            path: "README.md",
            additions: 1,
            deletions: 0,
            hunkCount: 1,
            patch: "@@ -1,1 +1,2 @@",
            hunks: [
              {
                index: 0,
                header: "@@ -1,1 +1,2 @@",
                oldRange: [1, 1],
                newRange: [1, 2],
              },
            ],
          },
        ],
      },
    });
  });

  test("runs reload commands through the daemon and returns the replacement session summary", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          reloadSession: async (input) => {
            expect(input.selector).toEqual({ sessionId: "session-1" });
            expect(input.nextInput).toEqual({
              kind: "show",
              ref: "HEAD~1",
              options: {},
            });

            return {
              sessionId: "session-1",
              inputKind: "show",
              title: "repo show HEAD~1",
              sourceLabel: "/repo",
              fileCount: 1,
              selectedFilePath: "README.md",
              selectedHunkIndex: 0,
            };
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "reload",
      selector: { sessionId: "session-1" },
      nextInput: {
        kind: "show",
        ref: "HEAD~1",
        options: {},
      },
      output: "json",
    } satisfies SessionCommandInput);

    expect(JSON.parse(output)).toEqual({
      result: {
        sessionId: "session-1",
        inputKind: "show",
        title: "repo show HEAD~1",
        sourceLabel: "/repo",
        fileCount: 1,
        selectedFilePath: "README.md",
        selectedHunkIndex: 0,
      },
    });
  });

  test("passes a separate source path through reload commands", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          reloadSession: async (input) => {
            expect(input.selector).toEqual({ sessionPath: "/live-session" });
            expect(input.sourcePath).toBe("/source-repo");
            expect(input.nextInput).toEqual({
              kind: "git",
              staged: false,
              options: {},
            });

            return {
              sessionId: "session-1",
              inputKind: "git",
              title: "source-repo working tree",
              sourceLabel: "/source-repo",
              fileCount: 1,
              selectedFilePath: "README.md",
              selectedHunkIndex: 0,
            };
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "reload",
      selector: { sessionPath: "/live-session" },
      sourcePath: "/source-repo",
      nextInput: {
        kind: "git",
        staged: false,
        options: {},
      },
      output: "json",
    } satisfies SessionCommandInput);

    expect(JSON.parse(output)).toEqual({
      result: {
        sessionId: "session-1",
        inputKind: "git",
        title: "source-repo working tree",
        sourceLabel: "/source-repo",
        fileCount: 1,
        selectedFilePath: "README.md",
        selectedHunkIndex: 0,
      },
    });
  });

  test("runs comment-apply commands through the daemon and formats the applied batch", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          applyComments: async (input) => {
            expect(input.selector).toEqual({ sessionId: "session-1" });
            expect(input.comments).toEqual([
              {
                filePath: "README.md",
                hunkNumber: 2,
                summary: "Explain the hunk",
              },
            ]);
            expect(input.revealMode).toBe("first");

            return {
              applied: [
                {
                  commentId: "comment-1",
                  fileId: "file-1",
                  filePath: "README.md",
                  hunkIndex: 1,
                  side: "new",
                  line: 20,
                },
              ],
            };
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "comment-apply",
      selector: { sessionId: "session-1" },
      comments: [
        {
          filePath: "README.md",
          hunkNumber: 2,
          summary: "Explain the hunk",
        },
      ],
      revealMode: "first",
      output: "text",
    } satisfies SessionCommandInput);

    expect(output).toBe(
      "Applied 1 live comments to session session-1:\n  - comment-1 on README.md:20 (new) hunk 2\n",
    );
  });

  test("does not restart when the daemon already exposes the needed session action", async () => {
    const restartCalls: string[] = [];

    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          getCapabilities: async () => ({
            version: HUNK_SESSION_API_VERSION,
            daemonVersion: HUNK_SESSION_DAEMON_VERSION,
            actions: [
              "list",
              "get",
              "context",
              "review",
              "navigate",
              "reload",
              "comment-add",
              "comment-apply",
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

  test("normalizes session-path selectors for reload commands before calling the daemon client", async () => {
    const expectedPath = resolve(".");

    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          reloadSession: async (input) => {
            const selector = input.selector;
            expect(selector).toEqual({
              sessionPath: expectedPath,
            });
            return {
              sessionId: "session-1",
              inputKind: "git",
              title: "repo working tree",
              sourceLabel: "/repo",
              fileCount: 1,
              selectedFilePath: "README.md",
              selectedHunkIndex: 0,
            };
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "reload",
      selector: { sessionPath: "." },
      nextInput: {
        kind: "git",
        staged: false,
        options: {},
      },
      output: "json",
    } satisfies SessionCommandInput);

    expect(JSON.parse(output)).toMatchObject({
      result: {
        sessionId: "session-1",
      },
    });
  });
});

describe("session list includes terminal metadata", () => {
  test("list output includes generic terminal and location lines when present", async () => {
    const session = {
      ...createTestListedSession("session-1"),
      terminal: {
        program: "iTerm.app",
        locations: [
          { source: "tty", tty: "/dev/ttys003" },
          { source: "tmux", paneId: "%2" },
          { source: "iterm2", windowId: "1", tabId: "2", paneId: "3" },
        ],
      },
    };

    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          listSessions: async () => [session],
        }),
      resolveDaemonAvailability: async () => true,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "list",
      output: "text",
    } satisfies SessionCommandInput);

    expect(output).toContain("terminal: iTerm.app");
    expect(output).toContain("location[tty]: /dev/ttys003");
    expect(output).toContain("location[tmux]: pane %2");
    expect(output).toContain("location[iterm2]: window 1, tab 2, pane 3");
  });

  test("list output omits terminal lines when absent", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          listSessions: async () => [createTestListedSession("session-1")],
        }),
      resolveDaemonAvailability: async () => true,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "list",
      output: "text",
    } satisfies SessionCommandInput);

    expect(output).not.toContain("terminal:");
    expect(output).not.toContain("location[");
  });

  test("get output includes generic terminal location lines when present", async () => {
    const session = {
      ...createTestListedSession("session-1"),
      terminal: {
        program: "ghostty",
        locations: [
          { source: "tty", tty: "/dev/ttys005" },
          { source: "tmux", paneId: "%0" },
        ],
      },
    };

    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          getSession: async () => session,
        }),
      resolveDaemonAvailability: async () => true,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "get",
      selector: { sessionId: "session-1" },
      output: "text",
    } satisfies SessionCommandInput);

    expect(output).toContain("Terminal: ghostty");
    expect(output).toContain("Location[tty]: /dev/ttys005");
    expect(output).toContain("Location[tmux]: pane %0");
  });

  test("json output includes terminal metadata fields", async () => {
    const session = {
      ...createTestListedSession("session-1"),
      terminal: {
        program: "iTerm.app",
        locations: [
          { source: "tty", tty: "/dev/ttys003" },
          { source: "tmux", paneId: "%2" },
        ],
      },
    };

    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          listSessions: async () => [session],
        }),
      resolveDaemonAvailability: async () => true,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "list",
      output: "json",
    } satisfies SessionCommandInput);

    const parsed = JSON.parse(output);
    expect(parsed.sessions[0].terminal).toEqual({
      program: "iTerm.app",
      locations: [
        { source: "tty", tty: "/dev/ttys003" },
        { source: "tmux", paneId: "%2" },
      ],
    });
    expect(parsed.sessions[0]).not.toHaveProperty("tty");
    expect(parsed.sessions[0]).not.toHaveProperty("tmuxPane");
  });
});
