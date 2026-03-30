import type { ScrollBoxRenderable } from "@opentui/core";
import type { DiffFile } from "../../core/types";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { startTransition, useEffect } from "react";
import { fileRowId } from "../lib/ids";

interface UseReviewSelectionSyncOptions {
  activeFile: DiffFile | undefined;
  files: DiffFile[];
  filesScrollRef: RefObject<ScrollBoxRenderable | null>;
  setSelectedFileId: Dispatch<SetStateAction<string>>;
  setSelectedHunkIndex: Dispatch<SetStateAction<number>>;
}

/** Keep the selected file and hunk valid as filtering and file visibility change. */
export function useReviewSelectionSync({
  activeFile,
  files,
  filesScrollRef,
  setSelectedFileId,
  setSelectedHunkIndex,
}: UseReviewSelectionSyncOptions) {
  useEffect(() => {
    const nextFile = activeFile ?? files[0];
    if (!activeFile && nextFile) {
      setSelectedFileId(nextFile.id);
      setSelectedHunkIndex(0);
      return;
    }

    if (activeFile && !files.some((file) => file.id === activeFile.id) && files[0]) {
      startTransition(() => {
        setSelectedFileId(files[0]!.id);
        setSelectedHunkIndex(0);
      });
    }
  }, [activeFile, files, setSelectedFileId, setSelectedHunkIndex]);

  useEffect(() => {
    if (activeFile) {
      setSelectedHunkIndex((current) =>
        Math.min(Math.max(current, 0), Math.max(0, activeFile.metadata.hunks.length - 1)),
      );
    }
  }, [activeFile, setSelectedHunkIndex]);

  useEffect(() => {
    if (activeFile) {
      filesScrollRef.current?.scrollChildIntoView(fileRowId(activeFile.id));
    }
  }, [activeFile, filesScrollRef]);
}
