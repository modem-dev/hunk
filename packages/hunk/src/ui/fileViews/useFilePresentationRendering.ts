import { useCallback, useEffect, useRef } from "react";
import type { DiffFile } from "../../core/changeset/model";
import type { RegisteredFileView } from "../../extensions/types";
import type { FileViewEpochState, FileViewSelectionState } from "./state";
import type { FileViewRowFailure } from "./types";
import { useFileViewLayouts } from "./useFileViews";

/** Bound row-render warning metadata even if a large custom tree fails throughout scrolling. */
const FILE_VIEW_RENDER_FAILURE_MAX_ENTRIES = 256;

export interface FilePresentationRendering {
  layouts: ReturnType<typeof useFileViewLayouts>;
  reportRowFailure: (failure: FileViewRowFailure) => void;
}

/** Prepare selected file presentations and attribute row failures to their extension. */
export function useFilePresentationRendering({
  files,
  selections,
  epochs,
  views,
  width,
  onIssue,
  onWarning,
}: {
  files: readonly DiffFile[];
  selections: Readonly<FileViewSelectionState>;
  epochs: FileViewEpochState;
  views: readonly RegisteredFileView[];
  width: number;
  onIssue: (message: string) => void;
  onWarning: (message: string) => void;
}): FilePresentationRendering {
  const layouts = useFileViewLayouts({ files, selections, views, width, epochs, onIssue });
  const reportedRowFailuresRef = useRef(
    new Map<string, { fileId: string; layoutGeneration: number }>(),
  );

  /** Report one concrete row failure once for its active layout generation. */
  const reportRowFailure = useCallback(
    (failure: FileViewRowFailure) => {
      const dedupeKey = [
        failure.extensionId,
        failure.viewId,
        failure.fileId,
        failure.rowId,
        failure.layoutGeneration,
        failure.message,
      ].join("\u0000");
      const reported = reportedRowFailuresRef.current;
      if (reported.has(dedupeKey)) return;
      reported.set(dedupeKey, {
        fileId: failure.fileId,
        layoutGeneration: failure.layoutGeneration,
      });
      if (reported.size > FILE_VIEW_RENDER_FAILURE_MAX_ENTRIES) {
        const oldest = reported.keys().next().value;
        if (oldest !== undefined) reported.delete(oldest);
      }
      onWarning(
        `Extension ${failure.extensionId} file view "${failure.viewId}" row "${failure.rowId}" failed rendering ${failure.filePath} • ${failure.message}`,
      );
    },
    [onWarning],
  );

  useEffect(() => {
    const activeGenerations = new Set(
      Array.from(layouts, ([fileId, layout]) => [fileId, layout.layoutGeneration].join("\u0000")),
    );
    for (const [key, failure] of reportedRowFailuresRef.current) {
      if (!activeGenerations.has([failure.fileId, failure.layoutGeneration].join("\u0000"))) {
        reportedRowFailuresRef.current.delete(key);
      }
    }
  }, [layouts]);

  return { layouts, reportRowFailure };
}
