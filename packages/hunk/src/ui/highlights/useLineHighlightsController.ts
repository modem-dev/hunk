import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionLineHighlightControls } from "../../extension-api/types";
import type { DiffFile } from "../../core/changeset/model";
import type { RegisteredLineHighlighter } from "../../extensions/types";
import { bumpScopedEpoch, reconcileScopedEpochs } from "../lib/scopedEpochs";
import {
  registeredLineHighlighterKey,
  resolveRegisteredLineHighlighter,
  type LineHighlightEpochState,
} from "./state";

export interface LineHighlightsController {
  /** Invalidation epochs requested through `ctx.highlights.refresh`. */
  epochs: LineHighlightEpochState;
  /** Build live host-owned highlight controls for one extension. */
  createControls: (extensionId: string) => ExtensionLineHighlightControls;
}

/** Own line-highlight invalidation state and the extension-facing refresh controls. */
export function useLineHighlightsController({
  files,
  highlighters,
  showNotice,
}: {
  files: readonly DiffFile[];
  highlighters: readonly RegisteredLineHighlighter[];
  showNotice: (message: string) => void;
}): LineHighlightsController {
  const [epochs, setEpochs] = useState<LineHighlightEpochState>(() => new Map<string, number>());
  const highlightersRef = useRef(highlighters);
  highlightersRef.current = highlighters;
  const fileIds = useMemo(() => new Set(files.map((file) => file.id)), [files]);
  const fileIdsRef = useRef<ReadonlySet<string>>(fileIds);
  fileIdsRef.current = fileIds;

  useEffect(() => {
    const keys = new Set(highlighters.map(registeredLineHighlighterKey));
    setEpochs((current) => reconcileScopedEpochs(current, [...fileIds], keys));
  }, [fileIds, highlighters]);

  const createControls = useCallback(
    (extensionId: string): ExtensionLineHighlightControls => {
      const controls: ExtensionLineHighlightControls = {
        refresh(highlighterId: string, options?: { fileId?: string }) {
          if (typeof highlighterId !== "string" || highlighterId.trim().length === 0) {
            showNotice(`Extension ${extensionId} targeted an invalid line highlighter id`);
            return;
          }
          const registered = resolveRegisteredLineHighlighter(
            highlightersRef.current,
            extensionId,
            highlighterId,
          );
          if (!registered) {
            showNotice(
              `Extension ${extensionId} targeted unknown line highlighter "${highlighterId}"`,
            );
            return;
          }
          const fileId = typeof options?.fileId === "string" ? options.fileId : undefined;
          // A stale id can race a reload. It invalidates nothing and does not warn the extension.
          if (fileId !== undefined && !fileIdsRef.current.has(fileId)) return;
          setEpochs((current) =>
            bumpScopedEpoch(current, registeredLineHighlighterKey(registered), fileId),
          );
        },
      };
      return Object.freeze(controls);
    },
    [showNotice],
  );

  return { epochs, createControls };
}
