import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  createTestListedSession as buildTestListedSession,
  createTestSelectedSessionContext,
  createTestSessionFileSummary,
  createTestSessionReview as buildTestSessionReview,
  createTestSessionSnapshot,
} from "../../../../../test/helpers/session-daemon-fixtures";
import type { SessionCommandInput, SessionSelectorInput } from "../../core/run/commandInputs";
import {
  runSessionCommand,
  setSessionCommandTestHooks,
  type HunkDaemonCliClient,
} from "./commands";
import { HUNK_SESSION_API_VERSION, HUNK_SESSION_DAEMON_VERSION } from "../protocol";
import { SessionBrokerClientAuthenticationError } from "@hunk/session-broker";

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
        "highlight-add",
        "highlight-clear",
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
    addHighlight: async () => ({
      fileId: "file-1",
      filePath: "README.md",
      hunkIndex: 0,
      side: "new",
      line: 1,
      start: 0,
      end: 4,
      tone: "match",
      fileMarkCount: 1,
    }),
    clearHighlights: async () => ({
      removedCount: 0,
      remainingCount: 0,
    }),
    ...overrides,
  };
}

afterEach(() => {
  setSessionCommandTestHooks(null);
});

describe("session command compatibility checks", () => {
  test("fails promptly without executing an action against an incompatible daemon", async () => {
    let contextCalls = 0;
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          getCapabilities: async () => null,
          getSelectedContext: async () => {
            contextCalls += 1;
            return createTestSelectedSessionContext();
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    await expect(
      runSessionCommand({
        kind: "session",
        action: "context",
        selector: { sessionId: "session-1" },
        output: "json",
      } satisfies SessionCommandInput),
    ).rejects.toThrow(
      "Close older Hunk windows, wait for the daemon to become idle, then retry this command.",
    );
    expect(contextCalls).toBe(0);
  });

  test("maps signed negotiation failure to quiescent upgrade guidance", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          getCapabilities: async () => {
            throw new SessionBrokerClientAuthenticationError();
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    await expect(
      runSessionCommand({ kind: "session", action: "list", output: "json" }),
    ).rejects.toThrow("Close older Hunk windows");
  });

  test("preserves local credential-store failures", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          getCapabilities: async () => {
            throw new Error("owner-private credential store is unsafe");
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    await expect(
      runSessionCommand({ kind: "session", action: "list", output: "json" }),
    ).rejects.toThrow("owner-private credential store is unsafe");
  });

  test("fails promptly when compatible capabilities omit the required action", async () => {
    let listCalls = 0;
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          getCapabilities: async () => ({
            version: HUNK_SESSION_API_VERSION,
            daemonVersion: HUNK_SESSION_DAEMON_VERSION,
            actions: ["get"],
          }),
          listSessions: async () => {
            listCalls += 1;
            return [];
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    await expect(
      runSessionCommand({ kind: "session", action: "list", output: "json" }),
    ).rejects.toThrow("missing required support for list");
    expect(listCalls).toBe(0);
  });

  test("runs review commands through the daemon without raw patch text by default", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          getSessionReview: async (input) => {
            expect(input.selector).toEqual({ sessionId: "session-1" });
            expect(input.includePatch).toBe(false);
            expect(input.includeNotes).toBe(false);

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
      includeNotes: false,
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
            expect(input.includeNotes).toBe(false);

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
      includeNotes: false,
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

  test("runs review commands through the daemon with notes when requested", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          getSessionReview: async (input) => {
            expect(input.selector).toEqual({ sessionId: "session-1" });
            expect(input.includePatch).toBe(false);
            expect(input.includeNotes).toBe(true);

            return {
              ...createTestSessionReview(false),
              reviewNoteCount: 1,
              reviewNotes: [
                {
                  noteId: "user:1",
                  source: "user",
                  filePath: "README.md",
                  body: "Please simplify this.",
                  author: "user",
                  createdAt: "2026-05-10T00:00:00.000Z",
                  editable: true,
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
      includeNotes: true,
    } satisfies SessionCommandInput);

    expect(JSON.parse(output)).toMatchObject({
      review: {
        reviewNoteCount: 1,
        reviewNotes: [{ noteId: "user:1", body: "Please simplify this." }],
      },
    });
  });

  test("routes typed comment listing through the comment list API", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          listComments: async (input) => {
            expect(input.selector).toEqual({ sessionId: "session-1" });
            expect(input.filePath).toBe("README.md");
            expect(input.type).toBe("user");
            return [
              {
                noteId: "user:1",
                source: "user",
                filePath: "README.md",
                hunkIndex: 0,
                body: "Human note",
                author: "user",
                createdAt: "2026-05-10T00:00:00.000Z",
                editable: true,
              },
            ];
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "comment-list",
      selector: { sessionId: "session-1" },
      filePath: "README.md",
      type: "user",
      output: "text",
    } satisfies SessionCommandInput);

    expect(output).toContain("user:1  README.md [user]");
    expect(output).toContain("body: Human note");
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

  test("forwards structured endpoints and a separate source path through reload commands", async () => {
    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          reloadSession: async (input) => {
            expect(input.selector).toEqual({
              repoRoot: undefined,
              sessionPath: resolve("/live-session"),
            });
            expect(input.sourcePath).toBe("/source-repo");
            expect(input.nextInput).toEqual({
              kind: "vcs",
              rangeEndpoints: { from: "main", to: "feature" },
              staged: false,
              options: {},
            });

            return {
              sessionId: "session-1",
              inputKind: "vcs",
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
        kind: "vcs",
        rangeEndpoints: { from: "main", to: "feature" },
        staged: false,
        options: {},
      },
      output: "json",
    } satisfies SessionCommandInput);

    expect(JSON.parse(output)).toEqual({
      result: {
        sessionId: "session-1",
        inputKind: "vcs",
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

  test("runs when the daemon already exposes the needed session action", async () => {
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
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "comment-list",
      selector: { sessionId: "session-1" },
      output: "json",
    } satisfies SessionCommandInput);

    expect(JSON.parse(output)).toEqual({ comments: [] });
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
              inputKind: "vcs",
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
        kind: "vcs",
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

  // Intent: session list uses a cheap no-daemon fallback without creating a client.
  test("list reports an empty session set when no daemon is available", async () => {
    setSessionCommandTestHooks({
      createClient: () => {
        throw new Error("list should not create a client without a daemon");
      },
      resolveDaemonAvailability: async () => false,
    });

    const output = await runSessionCommand({
      kind: "session",
      action: "list",
      output: "text",
    } satisfies SessionCommandInput);

    expect(output).toBe("No active Hunk sessions.\n");
  });

  // Intent: remaining command branches dispatch to the daemon and keep text output stable.
  test("routes remaining session actions through the daemon and formats text output", async () => {
    const selector: SessionSelectorInput = { sessionId: "session-1" };
    const calls: string[] = [];

    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          navigateToHunk: async (input) => {
            calls.push("navigate");
            expect(input.selector).toEqual(selector);
            expect(input.filePath).toBe("README.md");
            expect(input.hunkNumber).toBe(1);
            return { fileId: "file-1", filePath: "README.md", hunkIndex: 0 };
          },
          listComments: async (input) => {
            calls.push("comment-list");
            expect(input.selector).toEqual(selector);
            return [
              {
                commentId: "comment-1",
                filePath: "README.md",
                hunkIndex: 0,
                side: "new",
                line: 2,
                summary: "Explain this line",
                author: "agent",
                createdAt: "2026-05-10T00:00:00.000Z",
              },
            ];
          },
          removeComment: async (input) => {
            calls.push("comment-rm");
            expect(input.selector).toEqual(selector);
            expect(input.commentId).toBe("comment-1");
            return {
              commentId: "comment-1",
              removed: true,
              remainingCommentCount: 1,
            };
          },
          clearComments: async (input) => {
            calls.push("comment-clear");
            expect(input.selector).toEqual(selector);
            expect(input.filePath).toBe("README.md");
            return {
              filePath: "README.md",
              removedCount: 2,
              remainingCommentCount: 0,
            };
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    expect(
      await runSessionCommand({
        kind: "session",
        action: "navigate",
        selector,
        filePath: "README.md",
        hunkNumber: 1,
        output: "text",
      } satisfies SessionCommandInput),
    ).toBe("Focused README.md hunk 1 in session session-1.\n");

    expect(
      await runSessionCommand({
        kind: "session",
        action: "comment-list",
        selector,
        output: "text",
      } satisfies SessionCommandInput),
    ).toContain("comment-1  README.md:2 (new)");

    expect(
      await runSessionCommand({
        kind: "session",
        action: "comment-rm",
        selector,
        commentId: "comment-1",
        output: "text",
      } satisfies SessionCommandInput),
    ).toBe("Removed live comment comment-1 from session session-1. Remaining comments: 1.\n");

    expect(
      await runSessionCommand({
        kind: "session",
        action: "comment-clear",
        selector,
        filePath: "README.md",
        confirmed: true,
        output: "text",
      } satisfies SessionCommandInput),
    ).toBe("Cleared 2 live comments from README.md in session session-1. Remaining comments: 0.\n");

    expect(calls).toEqual(["navigate", "comment-list", "comment-rm", "comment-clear"]);
  });

  test("routes highlight actions through the daemon and formats text output", async () => {
    const selector: SessionSelectorInput = { sessionId: "session-1" };
    const calls: string[] = [];

    setSessionCommandTestHooks({
      createClient: () =>
        createClient({
          addHighlight: async (input) => {
            calls.push("highlight-add");
            expect(input.selector).toEqual(selector);
            expect(input.filePath).toBe("README.md");
            expect(input.side).toBe("new");
            expect(input.line).toBe(2);
            expect(input.start).toBe(4);
            expect(input.end).toBe(11);
            expect(input.tone).toBe("info");
            expect(input.reveal).toBe(true);
            return {
              fileId: "file-1",
              filePath: "README.md",
              hunkIndex: 0,
              side: "new",
              line: 2,
              start: 4,
              end: 11,
              tone: "info",
              fileMarkCount: 1,
              revealed: "line",
            };
          },
          clearHighlights: async (input) => {
            calls.push("highlight-clear");
            expect(input.selector).toEqual(selector);
            expect(input.filePath).toBeUndefined();
            return { removedCount: 1, remainingCount: 0 };
          },
        }),
      resolveDaemonAvailability: async () => true,
    });

    expect(
      await runSessionCommand({
        kind: "session",
        action: "highlight-add",
        selector,
        filePath: "README.md",
        side: "new",
        line: 2,
        start: 4,
        end: 11,
        tone: "info",
        reveal: true,
        output: "text",
      } satisfies SessionCommandInput),
    ).toBe(
      "Marked README.md:2 (new) [4, 11) as info in session session-1 and revealed its line. File marks: 1.\n",
    );

    expect(
      await runSessionCommand({
        kind: "session",
        action: "highlight-clear",
        selector,
        output: "text",
      } satisfies SessionCommandInput),
    ).toBe("Cleared 1 attention marks from session session-1. Remaining marks: 0.\n");

    expect(calls).toEqual(["highlight-add", "highlight-clear"]);
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
