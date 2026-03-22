import { useCallback, useEffect, useMemo, useState } from "react";
import type { DiffFile } from "../../core/types";
import { buildLiveComment, findDiffFileByPath, findHunkIndexForLine, hunkLineRange } from "../../core/liveComments";
import { HunkHostClient } from "../../mcp/client";
import type { LiveComment, SessionServerMessage } from "../../mcp/types";

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
  const [liveCommentsByFileId, setLiveCommentsByFileId] = useState<Record<string, LiveComment[]>>({});

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
      const liveComment = buildLiveComment(message.input, commentId, new Date().toISOString());

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
    if (!hostClient) {
      return;
    }

    hostClient.setBridge({
      applyComment: applyIncomingComment,
      navigateToHunk: navigateToHunkSelection,
    });

    return () => {
      hostClient.setBridge(null);
    };
  }, [applyIncomingComment, hostClient, navigateToHunkSelection]);

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
      updatedAt: new Date().toISOString(),
    });
  }, [currentHunk, hostClient, liveCommentCount, selectedFile?.id, selectedFile?.path, selectedHunkIndex, showAgentNotes]);

  return {
    liveCommentsByFileId,
    liveCommentCount,
  };
}
