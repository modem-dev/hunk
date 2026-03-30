import type { ScrollBoxRenderable } from "@opentui/core";
import type { RefObject } from "react";
import { useCallback, useState } from "react";
import { fileRowId } from "../lib/ids";

/** Own selected review anchors and the direct jumps that update them. */
export function useReviewSelectionState(
  initialFileId: string,
  filesScrollRef: RefObject<ScrollBoxRenderable | null>,
) {
  const [selectedFileId, setSelectedFileId] = useState(initialFileId);
  const [selectedHunkIndex, setSelectedHunkIndex] = useState(0);
  const [scrollToNote, setScrollToNote] = useState(false);

  const jumpToFile = useCallback(
    (fileId: string, nextHunkIndex = 0) => {
      filesScrollRef.current?.scrollChildIntoView(fileRowId(fileId));
      setSelectedFileId(fileId);
      setSelectedHunkIndex(nextHunkIndex);
      setScrollToNote(false);
    },
    [filesScrollRef],
  );

  const jumpToAnnotatedHunk = useCallback(
    (fileId: string, nextHunkIndex = 0) => {
      filesScrollRef.current?.scrollChildIntoView(fileRowId(fileId));
      setSelectedFileId(fileId);
      setSelectedHunkIndex(nextHunkIndex);
      setScrollToNote(true);
    },
    [filesScrollRef],
  );

  return {
    jumpToAnnotatedHunk,
    jumpToFile,
    scrollToNote,
    selectedFileId,
    selectedHunkIndex,
    setScrollToNote,
    setSelectedFileId,
    setSelectedHunkIndex,
  };
}
