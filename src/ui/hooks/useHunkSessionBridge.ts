import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CliInput, DiffFile } from "../../core/types";
import {
  buildLiveComment,
  findDiffFileByPath,
  findHunkIndexForLine,
  hunkLineRange,
} from "../../core/liveComments";
import { HunkHostClient } from "../../mcp/client";
import { filterReviewFiles, mergeFileAnnotationsByFileId } from "../lib/files";
import { buildAnnotatedHunkCursors, findNextHunkCursor } from "../lib/hunks";
import type {
  LiveComment,
  ReloadedSessionResult,
  SessionLiveCommentSummary,
  SessionServerMessage,
} from "../../mcp/types";

/** Bridge one live Hunk review session to the local MCP daemon. */
export function useHunkSessionBridge({
  currentHunk,
  files,
  filterQuery,
  hostClient,
  jumpToAnnotatedHunk,
  jumpToFile,
  openAgentNotes,
  reloadSession,
  selectedFile,
  selectedHunkIndex,
  showAgentNotes,
}: {
  currentHunk: DiffFile["metadata"]["hunks"][number] | undefined;
  files: DiffFile[];
  filterQuery: string;
  hostClient?: HunkHostClient;
  jumpToAnnotatedHunk: (fileId: string, nextHunkIndex?: number) => void;
  jumpToFile: (fileId: string, nextHunkIndex?: number) => void;
  openAgentNotes: () => void;
  reloadSession: (
    nextInput: CliInput,
    options?: { resetApp?: boolean; sourcePath?: string },
  ) => Promise<ReloadedSessionResult>;
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

  /** Merge live comments into the raw file list so annotation queries see both sources. */
  const filesWithLiveComments = useCallback(
    () => mergeFileAnnotationsByFileId(files, liveCommentsByFileIdRef.current),
    [files],
  );

  /** Apply the active filter to the merged file list so keyboard and CLI comment navigation agree. */
  const visibleFilesWithLiveComments = useCallback(
    () => filterReviewFiles(filesWithLiveComments(), filterQuery),
    [filesWithLiveComments, filterQuery],
  );

  const navigateToHunkSelection = useCallback(
    async (message: Extract<SessionServerMessage, { command: "navigate_to_hunk" }>) => {
      /** Handle relative comment navigation (--next-comment / --prev-comment). */
      if (message.input.commentDirection) {
        const delta = message.input.commentDirection === "next" ? 1 : -1;
        const visibleFiles = visibleFilesWithLiveComments();
        const annotatedCursors = buildAnnotatedHunkCursors(visibleFiles);
        const nextCursor = findNextHunkCursor(
          annotatedCursors,
          selectedFile?.id,
          selectedHunkIndex,
          delta,
        );

        if (!nextCursor) {
          throw new Error("No annotated hunks found in the current review.");
        }

        const targetFile = visibleFiles.find((file) => file.id === nextCursor.fileId);
        if (!targetFile) {
          throw new Error("Resolved annotated hunk references an unknown file.");
        }

        jumpToAnnotatedHunk(targetFile.id, nextCursor.hunkIndex);
        return {
          fileId: targetFile.id,
          filePath: targetFile.path,
          hunkIndex: nextCursor.hunkIndex,
          selectedHunk: buildSelectedHunkSummary(targetFile, nextCursor.hunkIndex),
        };
      }

      /** Handle absolute navigation by file + hunk/line target. */
      if (!message.input.filePath) {
        throw new Error(
          "navigate requires --file when not using --next-comment or --prev-comment.",
        );
      }

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
    [
      buildSelectedHunkSummary,
      files,
      jumpToAnnotatedHunk,
      jumpToFile,
      selectedFile?.id,
      selectedHunkIndex,
      visibleFilesWithLiveComments,
    ],
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

      if (message.input.reveal ?? false) {
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

  const reloadIncomingSession = useCallback(
    async (message: Extract<SessionServerMessage, { command: "reload_session" }>) =>
      reloadSession(message.input.nextInput, { sourcePath: message.input.sourcePath }),
    [reloadSession],
  );

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
      reloadSession: reloadIncomingSession,
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
    reloadIncomingSession,
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
