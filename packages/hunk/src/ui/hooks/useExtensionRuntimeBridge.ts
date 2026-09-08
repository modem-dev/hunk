/**
 * Keeps extension capabilities aligned with the App and review generation that committed them.
 *
 * Commands, lifecycle events, panes, dialogs, and workspace operations all mint controls through
 * this bridge. Runtime-level command controls survive content-only reloads, while review-bound
 * controls expire when the mounted bootstrap changes. Hard remounts and registry replacement
 * synchronously retire captured authority before AppHost publishes lifecycle events.
 *
 * App still composes commands and navigation behavior. This hook owns the committed refs, public
 * review projections, capability leases, and liveness checks those surfaces share.
 */

import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { AppBootstrap } from "../../core/bootstrap";
import type { DiffFile } from "../../core/changeset/model";
import type { ReviewState } from "../../core/review/state";
import type {
  ExtensionCommandControls,
  ExtensionReviewControls,
  ExtensionReviewNavigation,
  ExtensionReviewSelection,
} from "../../extension-api/types";
import { toReadOnlyFileViews } from "../../extensions/events";
import { buildExtensionReviewSnapshot } from "../../extensions/reviewSnapshot";
import type { ExtensionLoadResult } from "../../extensions/types";
import type { RevealedLineResult } from "./useTerminalReview";
import type { AppCommand } from "../lib/appCommands";
import {
  createExtensionCapabilityLease,
  type ExtensionCapabilityLease,
} from "../lib/extensionCapabilityLease";
import { createExtensionCommandControls } from "../lib/extensionCommandControls";
import { createGuardedReviewNavigation } from "../lib/extensionNavigation";
import { buildExtensionReviewSelection } from "../lib/extensionSelection";
import type { LineCursor } from "../lib/lineCursors";

export interface ExtensionRuntimeNavigationBindings {
  onSelectFile: (fileId: string) => void;
  onSelectHunk: (fileId: string, hunkIndex: number) => void;
  onRevealLine: (fileId: string, side: "old" | "new", line: number) => RevealedLineResult;
}

export interface ExtensionRuntimeBridge {
  commandControls: ExtensionCommandControls;
  /** Mint controls owned by the current registry and review generation. */
  createReviewCapabilityLease: () => ExtensionCapabilityLease;
  /** Build live navigation whose targets are resolved after awaited extension work. */
  createNavigation: (extensionId: string) => ExtensionReviewNavigation;
  /** Mint a review snapshot reader owned by the current review generation. */
  createReviewControls: () => ExtensionReviewControls;
  /** Read public file views for the latest committed review. */
  getCommittedFileViews: () => ReturnType<typeof toReadOnlyFileViews>;
  /** Project public file views for the render currently in progress. */
  getRenderFileViews: () => ReturnType<typeof toReadOnlyFileViews>;
  /** Snapshot the latest committed semantic selection at command invocation. */
  getSelection: () => ExtensionReviewSelection;
  /** Project selection for the render currently in progress. */
  getRenderSelection: () => ExtensionReviewSelection;
  /** Read the latest committed internal selected file id. */
  getSelectedFileId: () => string | null;
  /** Commit App-owned commands and navigation after the matching render succeeds. */
  commitBindings: (
    commands: readonly AppCommand[],
    navigation: ExtensionRuntimeNavigationBindings,
  ) => void;
}

interface ReviewSnapshotProducer {
  getPositionedReviewState: () => { generation: string; state: ReviewState } | undefined;
}

interface SelectionInputs {
  files: readonly DiffFile[];
  getSelection: () => { fileId: string | null; hunkIndex: number | null };
  getActiveLineCursor: () => Pick<LineCursor, "fileId" | "hunkIndex" | "target"> | null;
}

const unavailableNavigation: ExtensionRuntimeNavigationBindings = {
  onSelectFile: () => {},
  onSelectHunk: () => {},
  onRevealLine: () => "none",
};

/** Coordinate committed extension authority and public review projections. */
export function useExtensionRuntimeBridge({
  extensions,
  files,
  getActiveLineCursor,
  getSelection,
  reviewGeneration,
  reviewProducer,
}: {
  extensions?: ExtensionLoadResult;
  files: readonly DiffFile[];
  getActiveLineCursor: SelectionInputs["getActiveLineCursor"];
  getSelection: SelectionInputs["getSelection"];
  reviewGeneration: AppBootstrap;
  reviewProducer?: ReviewSnapshotProducer;
}): ExtensionRuntimeBridge {
  const appAliveRef = useRef(false);
  const activeRegistryRef = useRef(extensions?.registry);
  const activeReviewGenerationRef = useRef(reviewGeneration);
  const committedSelectionRef = useRef<SelectionInputs>({
    files,
    getSelection,
    getActiveLineCursor,
  });
  const commandsRef = useRef<readonly AppCommand[]>([]);
  const navigationRef = useRef<ExtensionRuntimeNavigationBindings>(unavailableNavigation);
  const fileViewsCacheRef = useRef<{
    source: readonly DiffFile[];
    views: ReturnType<typeof toReadOnlyFileViews>;
  } | null>(null);

  // Cache public file objects until the underlying visible-file list changes.
  const projectFileViews = useCallback((source: readonly DiffFile[]) => {
    const cache = fileViewsCacheRef.current;
    if (cache?.source === source) return cache.views;

    const views = toReadOnlyFileViews(source);
    fileViewsCacheRef.current = { source, views };
    return views;
  }, []);

  // Commit liveness and review facts before AppHost publishes lifecycle events.
  useLayoutEffect(() => {
    // Child layout effects commit before AppHost publishes startup/reload lifecycle events.
    appAliveRef.current = true;
    activeRegistryRef.current = extensions?.registry;
    activeReviewGenerationRef.current = reviewGeneration;
    committedSelectionRef.current = { files, getSelection, getActiveLineCursor };

    return () => {
      // Layout cleanup closes the hard-remount window before the parent can publish a successor.
      appAliveRef.current = false;
    };
  }, [extensions?.registry, files, getActiveLineCursor, getSelection, reviewGeneration]);

  const getCommittedFileViews = useCallback(
    () => projectFileViews(committedSelectionRef.current.files),
    [projectFileViews],
  );
  const getRenderFileViews = useCallback(() => projectFileViews(files), [files, projectFileViews]);

  // Command controls survive content reloads but expire with the App or registry.
  const commandControls = useMemo(() => {
    const lease = createExtensionCapabilityLease({
      owningRegistry: extensions?.registry,
      getActiveRegistry: () => activeRegistryRef.current,
      isAppAlive: () => appAliveRef.current,
    });
    return createExtensionCommandControls({
      getCommands: () => commandsRef.current,
      isLive: lease.isLive,
    });
  }, [extensions?.registry]);

  // Review controls also expire when the mounted review generation changes.
  const createReviewCapabilityLease = useCallback(
    () =>
      createExtensionCapabilityLease({
        owningRegistry: extensions?.registry,
        getActiveRegistry: () => activeRegistryRef.current,
        isAppAlive: () => appAliveRef.current,
        isReviewCurrent: () => activeReviewGenerationRef.current === reviewGeneration,
      }),
    [extensions?.registry, reviewGeneration],
  );

  // Freeze public selection from the latest committed review when a command starts.
  const getPublicSelection = useCallback(() => {
    const current = committedSelectionRef.current;
    const { fileId, hunkIndex } = current.getSelection();
    return buildExtensionReviewSelection({
      files: projectFileViews(current.files),
      selectedFileId: fileId,
      selectedHunkIndex: hunkIndex,
      lineCursor: current.getActiveLineCursor(),
    });
  }, [projectFileViews]);

  const getRenderSelection = useCallback(() => {
    const { fileId, hunkIndex } = getSelection();
    return buildExtensionReviewSelection({
      files: projectFileViews(files),
      selectedFileId: fileId,
      selectedHunkIndex: hunkIndex,
      lineCursor: getActiveLineCursor(),
    });
  }, [files, getActiveLineCursor, getSelection, projectFileViews]);

  const getSelectedFileId = useCallback(
    () => committedSelectionRef.current.getSelection().fileId,
    [],
  );

  // Resolve navigation targets and callbacks at call time, including after awaits.
  const createNavigation = useCallback(
    (extensionId: string) => {
      const lease = createReviewCapabilityLease();
      return createGuardedReviewNavigation({
        extensionId,
        getFiles: () => committedSelectionRef.current.files,
        isLive: lease.isLive,
        notify: (message, type) => extensions?.context.notify(message, type),
        onSelectFile: (fileId) => navigationRef.current.onSelectFile(fileId),
        onSelectHunk: (fileId, hunkIndex) => navigationRef.current.onSelectHunk(fileId, hunkIndex),
        onRevealLine: (fileId, side, line) =>
          navigationRef.current.onRevealLine(fileId, side, line),
      });
    },
    [createReviewCapabilityLease, extensions],
  );

  // Read snapshots only while the captured review generation is still current.
  const createReviewControls = useCallback(() => {
    const lease = createReviewCapabilityLease();
    return Object.freeze({
      snapshot() {
        if (!lease.isLive()) return null;
        const positioned = reviewProducer?.getPositionedReviewState();
        if (!positioned) return null;
        return buildExtensionReviewSnapshot(positioned.generation, positioned.state);
      },
    });
  }, [createReviewCapabilityLease, reviewProducer]);

  // Publish App-owned commands and navigation only after their render commits.
  const commitBindings = useCallback(
    (commands: readonly AppCommand[], navigation: ExtensionRuntimeNavigationBindings) => {
      commandsRef.current = commands;
      navigationRef.current = navigation;
    },
    [],
  );

  return {
    commandControls,
    createReviewCapabilityLease,
    createNavigation,
    createReviewControls,
    getCommittedFileViews,
    getRenderFileViews,
    getSelection: getPublicSelection,
    getRenderSelection,
    getSelectedFileId,
    commitBindings,
  };
}

/** Commit App-owned command and navigation bindings after their render succeeds. */
export function useExtensionRuntimeBindings({
  commands,
  navigation,
  runtime,
}: {
  commands: readonly AppCommand[];
  navigation: ExtensionRuntimeNavigationBindings;
  runtime: ExtensionRuntimeBridge;
}) {
  useLayoutEffect(() => {
    runtime.commitBindings(commands, navigation);
  }, [commands, navigation, runtime]);
}
