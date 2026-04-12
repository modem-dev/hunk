import { describe, expect, mock, test } from "bun:test";
import { createHunkSessionBridge } from "./bridge";

function createHandlers() {
  return {
    addLiveComment: mock((input, commentId) => ({
      commentId,
      fileId: "file-1",
      filePath: input.filePath,
      hunkIndex: 0,
      side: input.side ?? "new",
      line: input.line ?? 1,
    })),
    addLiveCommentBatch: mock((comments, requestId) => ({
      applied: comments.map((comment: (typeof comments)[number], index: number) => ({
        commentId: `${requestId}:${index}`,
        fileId: "file-1",
        filePath: comment.filePath,
        hunkIndex: comment.hunkIndex ?? index,
        side: comment.side ?? "new",
        line: comment.line ?? index + 1,
      })),
    })),
    clearLiveComments: mock((filePath?: string) => ({
      removedCount: filePath ? 1 : 2,
      remainingCommentCount: 0,
      filePath,
    })),
    navigateToLocation: mock((input) => ({
      fileId: "file-1",
      filePath: input.filePath ?? "src/example.ts",
      hunkIndex: input.hunkIndex ?? 0,
    })),
    openAgentNotes: mock(() => {}),
    reloadSession: mock(async (nextInput) => ({
      sessionId: "session-1",
      inputKind: nextInput.kind,
      title: "reloaded",
      sourceLabel: "/repo",
      fileCount: 1,
      selectedHunkIndex: 0,
    })),
    removeLiveComment: mock((commentId: string) => ({
      commentId,
      removed: true,
      remainingCommentCount: 0,
    })),
  };
}

describe("createHunkSessionBridge", () => {
  test("routes comment commands through the Hunk adapter and opens notes on reveal", async () => {
    const handlers = createHandlers();
    const bridge = createHunkSessionBridge(handlers);

    const result = await bridge.dispatchCommand({
      type: "command",
      requestId: "request-1",
      command: "comment",
      input: {
        sessionId: "session-1",
        filePath: "src/example.ts",
        side: "new",
        line: 4,
        summary: "Review note",
        reveal: true,
      },
    });

    expect(result).toMatchObject({ commentId: "mcp:request-1", filePath: "src/example.ts" });
    expect(handlers.addLiveComment).toHaveBeenCalledTimes(1);
    expect(handlers.openAgentNotes).toHaveBeenCalledTimes(1);
  });

  test("routes comment batches and reveals notes when the first applied comment should focus", async () => {
    const handlers = createHandlers();
    const bridge = createHunkSessionBridge(handlers);

    const result = await bridge.dispatchCommand({
      type: "command",
      requestId: "batch-1",
      command: "comment_batch",
      input: {
        sessionId: "session-1",
        revealMode: "first",
        comments: [
          { filePath: "src/example.ts", summary: "First" },
          { filePath: "src/example.ts", summary: "Second" },
        ],
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        applied: [
          expect.objectContaining({ commentId: "batch-1:0" }),
          expect.objectContaining({ commentId: "batch-1:1" }),
        ],
      }),
    );
    expect(handlers.addLiveCommentBatch).toHaveBeenCalledTimes(1);
    expect(handlers.openAgentNotes).toHaveBeenCalledTimes(1);
  });

  test("routes navigate, reload, remove, and clear commands through their dedicated handlers", async () => {
    const handlers = createHandlers();
    const bridge = createHunkSessionBridge(handlers);

    await bridge.dispatchCommand({
      type: "command",
      requestId: "nav-1",
      command: "navigate_to_hunk",
      input: { sessionId: "session-1", filePath: "src/example.ts", hunkIndex: 2 },
    });
    await bridge.dispatchCommand({
      type: "command",
      requestId: "reload-1",
      command: "reload_session",
      input: { sessionId: "session-1", nextInput: { kind: "git", staged: false, options: {} } },
    });
    await bridge.dispatchCommand({
      type: "command",
      requestId: "rm-1",
      command: "remove_comment",
      input: { sessionId: "session-1", commentId: "comment-1" },
    });
    await bridge.dispatchCommand({
      type: "command",
      requestId: "clear-1",
      command: "clear_comments",
      input: { sessionId: "session-1", filePath: "src/example.ts" },
    });

    expect(handlers.navigateToLocation).toHaveBeenCalledTimes(1);
    expect(handlers.reloadSession).toHaveBeenCalledTimes(1);
    expect(handlers.removeLiveComment).toHaveBeenCalledTimes(1);
    expect(handlers.clearLiveComments).toHaveBeenCalledTimes(1);
  });
});
