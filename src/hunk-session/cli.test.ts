import { afterEach, describe, expect, test } from "bun:test";
import {
  createTestListedSession,
  createTestSelectedSessionContext,
  createTestSessionFileSummary,
  createTestSessionLiveComment,
  createTestSessionReview,
  createTestSessionReviewFile,
  createTestSessionReviewHunk,
  createTestSessionSnapshot,
} from "../../test/helpers/session-daemon-fixtures";
import type { SessionSelectorInput } from "../core/types";
import {
  HUNK_SESSION_API_PATH,
  HUNK_SESSION_API_VERSION,
  HUNK_SESSION_DAEMON_VERSION,
} from "../session/protocol";
import {
  createHttpHunkSessionCliClient,
  formatClearCommentsOutput,
  formatCommentApplyOutput,
  formatCommentListOutput,
  formatCommentOutput,
  formatContextOutput,
  formatListOutput,
  formatNavigationOutput,
  formatReloadOutput,
  formatRemoveCommentOutput,
  formatReviewOutput,
  formatSessionOutput,
} from "./cli";

const selector = { sessionId: "session-1" } satisfies SessionSelectorInput;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("HTTP Hunk session CLI client", () => {
  test("maps CLI methods onto the daemon session API envelope", async () => {
    const requests: unknown[] = [];
    const session = createTestListedSession();
    const context = createTestSelectedSessionContext();
    const review = createTestSessionReview();
    const comment = {
      commentId: "comment-1",
      fileId: "file-1",
      filePath: "src/app.ts",
      hunkIndex: 0,
      side: "new" as const,
      line: 12,
    };
    const responses = {
      list: { sessions: [session] },
      get: { session },
      context: { context },
      review: { review },
      navigate: {
        result: {
          fileId: "file-1",
          filePath: "src/app.ts",
          hunkIndex: 1,
        },
      },
      reload: {
        result: {
          sessionId: "session-1",
          inputKind: "vcs" as const,
          title: "repo working tree",
          sourceLabel: "/repo",
          fileCount: 1,
          selectedFilePath: "src/app.ts",
          selectedHunkIndex: 0,
        },
      },
      "comment-add": { result: comment },
      "comment-apply": { result: { applied: [comment] } },
      "comment-list": { comments: [createTestSessionLiveComment()] },
      "comment-rm": {
        result: {
          commentId: "comment-1",
          removed: true,
          remainingCommentCount: 0,
        },
      },
      "comment-clear": {
        result: {
          removedCount: 1,
          remainingCommentCount: 0,
          filePath: "src/app.ts",
        },
      },
    };

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.endsWith(`${HUNK_SESSION_API_PATH}/capabilities`)) {
        return Response.json({
          version: HUNK_SESSION_API_VERSION,
          daemonVersion: HUNK_SESSION_DAEMON_VERSION,
          actions: Object.keys(responses),
        });
      }

      expect(url).toEndWith(HUNK_SESSION_API_PATH);
      expect(init?.method).toBe("POST");
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      return Response.json(responses[request.action as keyof typeof responses]);
    }) as typeof fetch;

    const client = createHttpHunkSessionCliClient();

    expect(await client.getCapabilities()).toMatchObject({ version: HUNK_SESSION_API_VERSION });
    expect(await client.listSessions()).toEqual([session]);
    expect(await client.getSession(selector)).toEqual(session);
    expect(await client.getSelectedContext(selector)).toEqual(context);
    expect(
      await client.getSessionReview({
        kind: "session",
        action: "review",
        selector,
        output: "json",
        includePatch: true,
      }),
    ).toEqual(review);
    expect(
      await client.navigateToHunk({
        kind: "session",
        action: "navigate",
        selector,
        filePath: "src/app.ts",
        hunkNumber: 2,
        side: "new",
        line: 12,
        commentDirection: "next",
        output: "json",
      }),
    ).toEqual({ fileId: "file-1", filePath: "src/app.ts", hunkIndex: 1 });
    expect(
      await client.reloadSession({
        kind: "session",
        action: "reload",
        selector,
        nextInput: { kind: "vcs", staged: false, options: {} },
        sourcePath: "/repo",
        output: "json",
      }),
    ).toMatchObject({ title: "repo working tree" });
    expect(
      await client.addComment({
        kind: "session",
        action: "comment-add",
        selector,
        filePath: "src/app.ts",
        side: "new",
        line: 12,
        summary: "Check this",
        rationale: "Preserve mapping",
        author: "pi",
        reveal: true,
        output: "json",
      }),
    ).toEqual(comment);
    expect(
      await client.applyComments({
        kind: "session",
        action: "comment-apply",
        selector,
        comments: [{ filePath: "src/app.ts", summary: "Check this" }],
        revealMode: "first",
        output: "json",
      }),
    ).toEqual({ applied: [comment] });
    expect(
      await client.listComments({
        kind: "session",
        action: "comment-list",
        selector,
        filePath: "src/app.ts",
        output: "json",
      }),
    ).toEqual([createTestSessionLiveComment()]);
    expect(
      await client.removeComment({
        kind: "session",
        action: "comment-rm",
        selector,
        commentId: "comment-1",
        output: "json",
      }),
    ).toMatchObject({ removed: true });
    expect(
      await client.clearComments({
        kind: "session",
        action: "comment-clear",
        selector,
        filePath: "src/app.ts",
        confirmed: true,
        output: "json",
      }),
    ).toMatchObject({ removedCount: 1 });

    expect(requests).toEqual([
      { action: "list" },
      { action: "get", selector },
      { action: "context", selector },
      { action: "review", selector, includePatch: true },
      {
        action: "navigate",
        selector,
        filePath: "src/app.ts",
        hunkNumber: 2,
        side: "new",
        line: 12,
        commentDirection: "next",
      },
      {
        action: "reload",
        selector,
        nextInput: { kind: "vcs", staged: false, options: {} },
        sourcePath: "/repo",
      },
      {
        action: "comment-add",
        selector,
        filePath: "src/app.ts",
        side: "new",
        line: 12,
        summary: "Check this",
        rationale: "Preserve mapping",
        author: "pi",
        reveal: true,
      },
      {
        action: "comment-apply",
        selector,
        comments: [{ filePath: "src/app.ts", summary: "Check this" }],
        revealMode: "first",
      },
      { action: "comment-list", selector, filePath: "src/app.ts" },
      { action: "comment-rm", selector, commentId: "comment-1" },
      { action: "comment-clear", selector, filePath: "src/app.ts" },
    ]);
  });

  test("times out hung daemon session API requests", async () => {
    globalThis.fetch = (async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;

    const client = createHttpHunkSessionCliClient({ timeoutMs: 10 });

    await expect(client.listSessions()).rejects.toThrow(
      "Timed out waiting for the Hunk session daemon to complete session list.",
    );
  });

  test("throws daemon response errors with JSON messages or status text fallbacks", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "No matching session." },
        { status: 404, statusText: "Not Found" },
      )) as unknown as typeof fetch;

    const client = createHttpHunkSessionCliClient();
    await expect(client.listSessions()).rejects.toThrow("No matching session.");

    globalThis.fetch = (async () =>
      new Response("not json", {
        status: 500,
        statusText: "Daemon exploded",
      })) as unknown as typeof fetch;

    await expect(client.listSessions()).rejects.toThrow("Daemon exploded");
  });
});

describe("Hunk session CLI formatters", () => {
  test("list and get output preserve terminal metadata and selected hunk summaries", () => {
    const session = createTestListedSession({
      files: [createTestSessionFileSummary({ path: "src/app.ts", additions: 3, deletions: 1 })],
      snapshot: createTestSessionSnapshot({
        selectedFilePath: "src/app.ts",
        selectedHunkIndex: 2,
        showAgentNotes: true,
        liveCommentCount: 4,
      }),
      terminal: {
        program: "ghostty",
        locations: [
          { source: "tty", tty: "/dev/ttys005" },
          { source: "tmux", paneId: "%7", sessionId: "work" },
          { source: "iterm2", windowId: "1", tabId: "2", paneId: "3", terminalId: "abc" },
          { source: "unknown" },
        ],
      },
    });

    expect(formatListOutput([session])).toBe(
      [
        "session-1  repo working tree",
        "  path: /repo",
        "  repo: /repo",
        "  terminal: ghostty",
        "  location[tty]: /dev/ttys005",
        "  location[tmux]: pane %7, session work",
        "  location[iterm2]: window 1, tab 2, pane 3, terminal abc",
        "  location[unknown]: present",
        "  focus: src/app.ts hunk 3",
        "  files: 1",
        "  comments: 4",
        "",
      ].join("\n"),
    );

    expect(formatSessionOutput(session)).toContain("Selected: src/app.ts hunk 3\n");
    expect(formatSessionOutput(session)).toContain("Agent notes visible: yes\n");
    expect(formatSessionOutput(session)).toContain("Live comments: 4\n");
    expect(formatSessionOutput(session)).toContain("  - src/app.ts (+3 -1, hunks: 1)");
  });

  test("empty and unselected summaries stay explicit in human-readable output", () => {
    const session = createTestListedSession({
      snapshot: createTestSessionSnapshot({
        selectedFileId: undefined,
        selectedFilePath: undefined,
        selectedHunkIndex: 0,
      }),
    });
    const context = createTestSelectedSessionContext({
      cwd: undefined,
      repoRoot: undefined,
      selectedFile: null,
      selectedHunk: null,
      showAgentNotes: true,
      liveCommentCount: 2,
    });

    expect(formatListOutput([])).toBe("No active Hunk sessions.\n");
    expect(formatListOutput([session])).toContain("  focus: (none)\n");
    expect(formatContextOutput(context)).toBe(
      [
        "Session: session-1",
        "Title: repo diff",
        "Path: -",
        "Repo: -",
        "File: (none)",
        "Hunk: -",
        "Old range: -",
        "New range: -",
        "Agent notes visible: yes",
        "Live comments: 2",
        "",
      ].join("\n"),
    );
  });

  test("review output keeps file order, hunk headers, and no-selection fallbacks", () => {
    const firstFile = createTestSessionReviewFile({
      id: "file-1",
      path: "src/first.ts",
      additions: 2,
      deletions: 1,
      hunkCount: 2,
      hunks: [
        createTestSessionReviewHunk({ index: 0, header: "@@ -1,1 +1,2 @@" }),
        createTestSessionReviewHunk({ index: 1, header: "@@ -10,1 +11,1 @@" }),
      ],
    });
    const secondFile = createTestSessionReviewFile({
      id: "file-2",
      path: "src/second.ts",
      additions: 0,
      deletions: 1,
      hunkCount: 1,
    });

    expect(
      formatReviewOutput(
        createTestSessionReview({
          files: [firstFile, secondFile],
          selectedFile: null,
          selectedHunk: null,
          title: "repo diff",
          inputKind: "diff",
          liveCommentCount: 1,
        }),
      ),
    ).toBe(
      [
        "Session: session-1",
        "Title: repo diff",
        "Source: /repo",
        "Path: -",
        "Repo: /repo",
        "Input: diff",
        "Selected file: (none)",
        "Selected hunk: -",
        "Agent notes visible: no",
        "Live comments: 1",
        "Review notes: 0",
        "Files:",
        "  - src/first.ts (+2 -1, hunks: 2)",
        "      hunk 1: @@ -1,1 +1,2 @@",
        "      hunk 2: @@ -10,1 +11,1 @@",
        "  - src/second.ts (+0 -1, hunks: 1)",
        "      hunk 1: @@ -1,1 +1,1 @@",
        "",
      ].join("\n"),
    );
  });

  test("command result formatters describe comment and navigation side effects", () => {
    expect(
      formatNavigationOutput(selector, {
        fileId: "file-1",
        filePath: "src/app.ts",
        hunkIndex: 1,
      }),
    ).toBe("Focused src/app.ts hunk 2 in session session-1.\n");

    expect(
      formatReloadOutput(selector, {
        sessionId: "session-1",
        inputKind: "vcs",
        title: "repo working tree",
        sourceLabel: "/repo",
        fileCount: 0,
        selectedFilePath: undefined,
        selectedHunkIndex: 0,
      }),
    ).toBe("Reloaded session session-1 with repo working tree (0 files). Selected: (no files).\n");

    expect(
      formatCommentOutput(selector, {
        commentId: "comment-1",
        fileId: "file-1",
        filePath: "src/app.ts",
        hunkIndex: 0,
        side: "new",
        line: 12,
      }),
    ).toBe(
      "Added live comment comment-1 on src/app.ts:12 (new) in hunk 1 for session session-1.\n",
    );

    expect(
      formatCommentOutput(selector, {
        commentId: "comment-1",
        fileId: "file-1",
        filePath: "src/app.ts",
        hunkIndex: 0,
        side: "new",
        line: 12,
        markupNotes: ["unknown tag <sparkline>"],
      }),
    ).toBe(
      "Added live comment comment-1 on src/app.ts:12 (new) in hunk 1 for session session-1.\n" +
        "Markup note: unknown tag <sparkline> (preview with `hunk markup render`).\n",
    );

    expect(formatCommentApplyOutput(selector, { applied: [] })).toBe(
      "Applied 0 live comments to session session-1.\n",
    );
    expect(
      formatCommentApplyOutput(selector, {
        applied: [
          {
            commentId: "comment-2",
            fileId: "file-1",
            filePath: "src/app.ts",
            hunkIndex: 2,
            side: "old",
            line: 8,
          },
        ],
      }),
    ).toBe(
      "Applied 1 live comments to session session-1:\n  - comment-2 on src/app.ts:8 (old) hunk 3\n",
    );

    expect(formatCommentListOutput(selector, [])).toBe("No live comments for session session-1.\n");
    expect(
      formatCommentListOutput(selector, [
        createTestSessionLiveComment({
          commentId: "comment-3",
          filePath: "src/app.ts",
          hunkIndex: 1,
          side: "new",
          line: 20,
          summary: "Check this branch",
          author: "pi",
        }),
      ]),
    ).toBe(
      "comment-3  src/app.ts:20 (new)\n  hunk: 2\n  summary: Check this branch\n  author: pi\n",
    );

    expect(
      formatRemoveCommentOutput(selector, {
        commentId: "comment-3",
        removed: true,
        remainingCommentCount: 1,
      }),
    ).toBe("Removed live comment comment-3 from session session-1. Remaining comments: 1.\n");

    expect(
      formatClearCommentsOutput(selector, {
        filePath: "src/app.ts",
        removedCount: 2,
        remainingCommentCount: 3,
      }),
    ).toBe(
      "Cleared 2 live comments from src/app.ts in session session-1. Remaining comments: 3.\n",
    );
    expect(
      formatClearCommentsOutput(selector, {
        removedCount: 5,
        remainingCommentCount: 0,
      }),
    ).toBe("Cleared 5 live comments from session session-1. Remaining comments: 0.\n");
  });
});
