import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffFile } from "../../core/types";
import {
  buildLiveComment,
  findDiffFileByPath,
  findHunkIndexForLine,
  hunkLineRange,
} from "../../core/liveComments";
import { HunkHostClient } from "../../mcp/client";
import type { LiveComment, SessionLiveCommentSummary, SessionServerMessage } from "../../mcp/types";

/** Bridge one live Hunk review session to the local MCP daemon. */
export function useHunkSessionBridge({
  currentHunk,
  files,
  hostClient,
  jumpToFile,
  openAgentNotes,
  selectedFile,
  selectedHunkIndex,
  showAgentNotes,
}: {
  currentHunk: DiffFile["metadata"]["hunks"][number] | undefined;
  files: DiffFile[];
  hostClient?: HunkHostClient;
  jumpToFile: (fileId: string, nextHunkIndex?: number) => void;
  openAgentNotes: () => void;
  selectedFile: DiffFile | undefined;
  selectedHunkIndex: number;
  showAgentNotes: boolean;
}) {
  const [liveCommentsByFileId, setLiveCommentsByFileId] = useState<Record<string, LiveComment[]>>(
    {},
  );
  const liveCommentsByFileIdRef = useRef<Record<string, LiveComment[]>>({});

  const buildSelectedHunkSummary = useCallback((file: DiffFile, hunkIndex: number) => {
    const hunk = file.metadata.hunks[hunkIndex];
    return hunk
      ? {
          index: hunkIndex,
          ...hunkLineRange(hunk),
        }
      : {
          index: hunkIndex,
        };
  }, []);

  const navigateToHunkSelection = useCallback(
    async (message: Extract<SessionServerMessage, { command: "navigate_to_hunk" }>) => {
      const file = findDiffFileByPath(files, message.input.filePath);
      if (!file) {
        throw new Error(`No visible diff file matches ${message.input.filePath}.`);
      }

      let hunkIndex = message.input.hunkIndex;
      if (hunkIndex === undefined) {
        if (!message.input.side || message.input.line === undefined) {
          throw new Error("navigate_to_hunk requires either hunkIndex or both side and line.");
        }

        hunkIndex = findHunkIndexForLine(file, message.input.side, message.input.line);
      }

      if (hunkIndex < 0 || hunkIndex >= file.metadata.hunks.length) {
        throw new Error(`No diff hunk in ${message.input.filePath} matches the requested target.`);
      }

      jumpToFile(file.id, hunkIndex);
      return {
        fileId: file.id,
        filePath: file.path,
        hunkIndex,
        selectedHunk: buildSelectedHunkSummary(file, hunkIndex),
      };
    },
    [buildSelectedHunkSummary, files, jumpToFile],
  );

  const applyIncomingComment = useCallback(
    async (message: Extract<SessionServerMessage, { command: "comment" }>) => {
      const file = findDiffFileByPath(files, message.input.filePath);
      if (!file) {
        throw new Error(`No visible diff file matches ${message.input.filePath}.`);
      }

      const hunkIndex = findHunkIndexForLine(file, message.input.side, message.input.line);
      if (hunkIndex < 0) {
        throw new Error(
          `No ${message.input.side} diff hunk in ${message.input.filePath} covers line ${message.input.line}.`,
        );
      }

      const commentId = `mcp:${message.requestId}`;
      const liveComment = buildLiveComment(
        message.input,
        commentId,
        new Date().toISOString(),
        hunkIndex,
      );

      setLiveCommentsByFileId((current) => ({
        ...current,
        [file.id]: [...(current[file.id] ?? []), liveComment],
      }));

      if (message.input.reveal ?? true) {
        jumpToFile(file.id, hunkIndex);
        openAgentNotes();
      }

      return {
        commentId,
        fileId: file.id,
        filePath: file.path,
        hunkIndex,
        side: message.input.side,
        line: message.input.line,
      };
    },
    [files, jumpToFile, openAgentNotes],
  );

  useEffect(() => {
    liveCommentsByFileIdRef.current = liveCommentsByFileId;
  }, [liveCommentsByFileId]);

  const removeIncomingComment = useCallback(
    async (message: Extract<SessionServerMessage, { command: "remove_comment" }>) => {
      const current = liveCommentsByFileIdRef.current;
      let removed = false;
      let remainingCommentCount = 0;
      const next: Record<string, LiveComment[]> = {};

      for (const [fileId, comments] of Object.entries(current)) {
        const filtered = comments.filter((comment) => comment.id !== message.input.commentId);
        if (filtered.length !== comments.length) {
          removed = true;
        }

        if (filtered.length > 0) {
          next[fileId] = filtered;
          remainingCommentCount += filtered.length;
        }
      }

      if (!removed) {
        throw new Error(`No live comment matches id ${message.input.commentId}.`);
      }

      setLiveCommentsByFileId(next);
      return {
        commentId: message.input.commentId,
        removed: true,
        remainingCommentCount,
      };
    },
    [],
  );

  const clearIncomingComments = useCallback(
    async (message: Extract<SessionServerMessage, { command: "clear_comments" }>) => {
      const current = liveCommentsByFileIdRef.current;
      let removedCount = 0;
      let remainingCommentCount = 0;

      if (message.input.filePath) {
        const file = findDiffFileByPath(files, message.input.filePath);
        if (!file) {
          throw new Error(`No visible diff file matches ${message.input.filePath}.`);
        }

        const next: Record<string, LiveComment[]> = {};
        for (const [fileId, comments] of Object.entries(current)) {
          if (fileId === file.id) {
            removedCount = comments.length;
            continue;
          }

          next[fileId] = comments;
          remainingCommentCount += comments.length;
        }

        if (removedCount > 0) {
          setLiveCommentsByFileId(next);
        }
      } else {
        removedCount = Object.values(current).reduce((sum, comments) => sum + comments.length, 0);
        if (removedCount > 0) {
          setLiveCommentsByFileId({});
        }
      }

      return {
        removedCount,
        remainingCommentCount,
        filePath: message.input.filePath,
      };
    },
    [files],
  );

  useEffect(() => {
    if (!hostClient) {
      return;
    }

    hostClient.setBridge({
      applyComment: applyIncomingComment,
      navigateToHunk: navigateToHunkSelection,
      removeComment: removeIncomingComment,
      clearComments: clearIncomingComments,
    });

    return () => {
      hostClient.setBridge(null);
    };
  }, [
    applyIncomingComment,
    clearIncomingComments,
    hostClient,
    navigateToHunkSelection,
    removeIncomingComment,
  ]);

  const liveCommentSummaries = useMemo<SessionLiveCommentSummary[]>(
    () =>
      files.flatMap((file) =>
        (liveCommentsByFileId[file.id] ?? []).map((comment) => ({
          commentId: comment.id,
          filePath: file.path,
          hunkIndex: comment.hunkIndex,
          side: comment.side,
          line: comment.line,
          summary: comment.summary,
          rationale: comment.rationale,
          author: comment.author,
          createdAt: comment.createdAt,
        })),
      ),
    [files, liveCommentsByFileId],
  );

  const liveCommentCount = useMemo(
    () => Object.values(liveCommentsByFileId).reduce((sum, notes) => sum + notes.length, 0),
    [liveCommentsByFileId],
  );

  useEffect(() => {
    const selectedRange = currentHunk ? hunkLineRange(currentHunk) : undefined;

    hostClient?.updateSnapshot({
      selectedFileId: selectedFile?.id,
      selectedFilePath: selectedFile?.path,
      selectedHunkIndex,
      selectedHunkOldRange: selectedRange?.oldRange,
      selectedHunkNewRange: selectedRange?.newRange,
      showAgentNotes,
      liveCommentCount,
      liveComments: liveCommentSummaries,
      updatedAt: new Date().toISOString(),
    });
  }, [
    currentHunk,
    hostClient,
    liveCommentCount,
    liveCommentSummaries,
    selectedFile?.id,
    selectedFile?.path,
    selectedHunkIndex,
    showAgentNotes,
  ]);

  return {
    liveCommentsByFileId,
    liveCommentCount,
  };
}
