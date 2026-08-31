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
} from "../../../test/helpers/session-daemon-fixtures";
import type { SessionSelectorInput } from "../../core/run/commandInputs";
import {
  HUNK_SESSION_API_PATH,
  HUNK_SESSION_API_VERSION,
  HUNK_SESSION_DAEMON_VERSION,
} from "../protocol";
import {
  createHttpHunkSessionCliClient,
  formatClearCommentsOutput,
  formatClearHighlightsOutput,
  formatCommentApplyOutput,
  formatCommentListOutput,
  formatCommentOutput,
  formatContextOutput,
  formatHighlightOutput,
  formatListOutput,
  formatNavigationOutput,
  formatReloadOutput,
  formatRemoveCommentOutput,
  formatReviewOutput,
  formatSessionOutput,
} from "./cliClient";

const selector = { sessionId: "session-1" } satisfies SessionSelectorInput;
const originalFetch = globalThis.fetch;
const injectedCaller = {
  request: (path: string, init?: RequestInit) => globalThis.fetch(path, init),
};

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
      "highlight-add": {
        result: {
          fileId: "file-1",
          filePath: "src/app.ts",
          hunkIndex: 0,
          side: "new" as const,
          line: 12,
          start: 2,
          end: 9,
          tone: "warning" as const,
          fileMarkCount: 1,
          revealed: "line" as const,
        },
      },
      "highlight-clear": {
        result: {
          removedCount: 2,
          remainingCount: 0,
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

    const client = createHttpHunkSessionCliClient({ caller: injectedCaller });

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
      await client.navigateToHunk({
        kind: "session",
        action: "navigate",
        selector,
        commentId: "comment-1",
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
    expect(
      await client.addHighlight({
        kind: "session",
        action: "highlight-add",
        selector,
        filePath: "src/app.ts",
        side: "new",
        line: 12,
        start: 2,
        end: 9,
        tone: "warning",
        reveal: true,
        output: "json",
      }),
    ).toMatchObject({ fileMarkCount: 1, revealed: "line" });
    expect(
      await client.clearHighlights({
        kind: "session",
        action: "highlight-clear",
        selector,
        filePath: "src/app.ts",
        output: "json",
      }),
    ).toMatchObject({ removedCount: 2 });

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
        action: "navigate",
        selector,
        commentId: "comment-1",
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
      {
        action: "highlight-add",
        selector,
        filePath: "src/app.ts",
        side: "new",
        line: 12,
        start: 2,
        end: 9,
        tone: "warning",
        reveal: true,
      },
      { action: "highlight-clear", selector, filePath: "src/app.ts" },
    ]);
  });

  test("times out hung daemon session API requests", async () => {
    globalThis.fetch = (async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;

    const client = createHttpHunkSessionCliClient({ timeoutMs: 10, caller: injectedCaller });

    await expect(client.listSessions()).rejects.toThrow(
      "Timed out waiting for the Hunk session daemon to complete session list.",
    );
  });

  test("rejects malformed successful responses instead of returning asserted types", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        sessions: [{ sessionId: "partial", unknown: true }],
      })) as unknown as typeof fetch;

    const client = createHttpHunkSessionCliClient({ caller: injectedCaller });
    await expect(client.listSessions()).rejects.toThrow(
      "Invalid Hunk session daemon response for list.",
    );

    globalThis.fetch = (async () => new Response("not json")) as unknown as typeof fetch;
    await expect(client.listSessions()).rejects.toThrow(
      "Invalid Hunk session daemon response for list.",
    );
  });

  test("returns schema-transformed response objects", async () => {
    const session = createTestListedSession();
    globalThis.fetch = (async () =>
      Response.json({ sessions: [session] })) as unknown as typeof fetch;

    const client = createHttpHunkSessionCliClient({ caller: injectedCaller });
    const result = await client.listSessions();
    expect(result).toEqual([session]);
    expect(result[0]).not.toBe(session);
  });

  test("throws daemon response errors with JSON messages or status text fallbacks", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "No matching session." },
        { status: 404, statusText: "Not Found" },
      )) as unknown as typeof fetch;

    const client = createHttpHunkSessionCliClient({ caller: injectedCaller });
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

  test("human-readable session paths cannot emit terminal controls", () => {
    const unsafePath = "src/日本語\x1b[2J\tline\n🧪.ts";
    const session = createTestListedSession({
      title: unsafePath,
      sourceLabel: unsafePath,
      cwd: unsafePath,
      repoRoot: unsafePath,
      files: [createTestSessionFileSummary({ path: unsafePath })],
      snapshot: createTestSessionSnapshot({ selectedFilePath: unsafePath }),
    });
    const output = formatSessionOutput(session);

    expect(output).not.toContain("\x1b");
    expect(output).not.toContain("\t");
    expect(output).toContain("src/日本語line🧪.ts");

    const reloadOutput = formatReloadOutput(
      { sessionPath: unsafePath },
      {
        sessionId: "session-1",
        inputKind: "vcs",
        title: "repo working tree",
        sourceLabel: "/repo",
        fileCount: 1,
        selectedFilePath: unsafePath,
        selectedHunkIndex: 0,
      },
    );
    expect(reloadOutput).not.toContain("\x1b");
    expect(reloadOutput).not.toContain("\t");
    expect(reloadOutput).toContain("session path src/日本語line🧪.ts");
    expect(reloadOutput).toContain("Selected: src/日本語line🧪.ts hunk 1");
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

  test("context output exposes STML geometry only for opted-in sessions", () => {
    const normal = createTestSelectedSessionContext({
      experimentalFeatures: [],
      noteMarkupWidth: undefined,
    });
    const experimental = createTestSelectedSessionContext({
      experimentalFeatures: ["stml"],
      noteMarkupWidth: 72,
    });

    expect(formatContextOutput(normal)).not.toContain("markup");
    expect(formatContextOutput(normal)).not.toContain("Experimental features");
    expect(formatContextOutput(experimental)).toContain("Experimental features: stml\n");
    expect(formatContextOutput(experimental)).toContain("Note markup width: 72\n");
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

  test("highlight formatters describe marks, reveals, and line-exact navigation", () => {
    expect(
      formatNavigationOutput(selector, {
        fileId: "file-1",
        filePath: "src/app.ts",
        hunkIndex: 1,
        revealed: "line",
        side: "new",
        line: 42,
      }),
    ).toBe("Revealed src/app.ts:42 (new) in hunk 2 of session session-1.\n");
    // A hunk fallback reads as the classic focus message, not a false line claim.
    expect(
      formatNavigationOutput(selector, {
        fileId: "file-1",
        filePath: "src/app.ts",
        hunkIndex: 1,
        revealed: "hunk",
        side: "new",
        line: 42,
      }),
    ).toBe("Focused src/app.ts hunk 2 in session session-1.\n");

    expect(
      formatHighlightOutput(selector, {
        fileId: "file-1",
        filePath: "src/app.ts",
        hunkIndex: 0,
        side: "new",
        line: 12,
        start: 2,
        end: 9,
        tone: "warning",
        fileMarkCount: 3,
        revealed: "line",
      }),
    ).toBe(
      "Marked src/app.ts:12 (new) [2, 9) as warning in session session-1 and revealed its line. File marks: 3.\n",
    );
    expect(
      formatHighlightOutput(selector, {
        fileId: "file-1",
        filePath: "src/app.ts",
        hunkIndex: 0,
        side: "old",
        line: 7,
        start: 0,
        end: 4,
        tone: "match",
        fileMarkCount: 1,
      }),
    ).toBe("Marked src/app.ts:7 (old) [0, 4) as match in session session-1. File marks: 1.\n");

    expect(
      formatClearHighlightsOutput(selector, {
        removedCount: 2,
        remainingCount: 1,
        filePath: "src/app.ts",
      }),
    ).toBe("Cleared 2 attention marks from src/app.ts in session session-1. Remaining marks: 1.\n");
    expect(
      formatClearHighlightsOutput(selector, {
        removedCount: 4,
        remainingCount: 0,
      }),
    ).toBe("Cleared 4 attention marks from session session-1. Remaining marks: 0.\n");
  });
});
