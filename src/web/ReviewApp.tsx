/** @jsxImportSource react */
/**
 * The browser review page: a file list, the review stream, and what the connection is doing.
 *
 * Read-only by construction — nothing here dispatches an action, edits a note, or publishes
 * a selection. It subscribes to the mirror, renders whatever document the mirror holds, and
 * says in the shared catalog's words when something failed
 * (`docs/browser-review-seam-audit.md`, G4).
 *
 * The sidebar is navigation only, as it is in the terminal: selecting a file moves the
 * stream to that file rather than collapsing the stream to it.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { formatReviewAddress } from "../core/review/address";
import { reviewFileStatBadges } from "../core/review/presentation";
import type { ReviewFileV1 } from "../core/review/types";
import type { BrowserReviewApiClient } from "./reviewApiClient";
import type { BrowserReviewMirror, BrowserReviewMirrorSnapshot } from "./reviewMirror";
import {
  BrowserReviewSourceStore,
  type BrowserReviewSourceEntries,
  type BrowserReviewSourceSnapshot,
} from "./reviewSources";
import { BrowserReviewStream } from "./ReviewStream";
import {
  resolveBrowserViewOptions,
  type BrowserViewOptions,
  type BrowserHostViewDefaults,
} from "./viewOptions";

export interface BrowserReviewAppProps {
  mirror: BrowserReviewMirror;
  client: BrowserReviewApiClient;
  /** The host's resolved view defaults, when the page was served with them (G1). */
  hostViewDefaults?: BrowserHostViewDefaults;
}

/** Watch one mirror as a React store, without copying its state into component state. */
function useReviewMirror(mirror: BrowserReviewMirror): BrowserReviewMirrorSnapshot {
  return useSyncExternalStore(
    useCallback((notify) => mirror.subscribe(notify), [mirror]),
    useCallback(() => mirror.getSnapshot(), [mirror]),
    useCallback(() => mirror.getSnapshot(), [mirror]),
  );
}

/** No source read yet, and a stable identity so an empty render is not a new object. */
const NO_SOURCES: BrowserReviewSourceEntries = {};

/** Watch one source store the same way, so a read that lands re-renders the gaps it fills. */
function useReviewSources(sources: BrowserReviewSourceStore): BrowserReviewSourceSnapshot {
  return useSyncExternalStore(
    useCallback((notify) => sources.subscribe(notify), [sources]),
    useCallback(() => sources.getSnapshot(), [sources]),
    useCallback(() => sources.getSnapshot(), [sources]),
  );
}

/** Track the viewport width the responsive layout decides from. */
function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

export function BrowserReviewApp({ mirror, client, hostViewDefaults }: BrowserReviewAppProps) {
  const snapshot = useReviewMirror(mirror);
  const viewportWidth = useViewportWidth();
  const [view] = useState<BrowserViewOptions>(() => resolveBrowserViewOptions(hostViewDefaults));
  const sources = useMemo(() => new BrowserReviewSourceStore(client), [client]);
  const sourceSnapshot = useReviewSources(sources);

  // The page owns the mirror's attachment for as long as it is on screen; the mirror can be
  // attached again, so a remount picks the same review back up rather than going dark.
  useEffect(() => {
    mirror.start();
    return () => mirror.stop();
  }, [mirror]);

  // A generation change invalidates every source it was read for: the same file key over
  // new content is different text. The store is pointed at the new generation in an effect,
  // which runs after this render, so what is drawn is guarded on the generation the entries
  // were read for rather than on the effect having caught up.
  const generation = snapshot.publication?.generation;
  useEffect(() => {
    sources.setGeneration(generation);
  }, [sources, generation]);
  const sourceByFileKey =
    sourceSnapshot.generation === generation ? sourceSnapshot.entries : NO_SOURCES;

  const requestSource = useCallback((file: ReviewFileV1) => sources.request(file), [sources]);

  return (
    <div className="review-app">
      <ReviewStatus snapshot={snapshot} />
      {snapshot.document ? (
        <div className="review-body">
          <ReviewFileList files={snapshot.document.files} />
          <BrowserReviewStream
            document={snapshot.document}
            view={view}
            viewportWidth={viewportWidth}
            sourceByFileKey={sourceByFileKey}
            onRequestSource={requestSource}
          />
        </div>
      ) : null}
    </div>
  );
}

/** What the connection is doing, in the shared catalog's words when it went wrong. */
function ReviewStatus({ snapshot }: { snapshot: BrowserReviewMirrorSnapshot }) {
  return (
    <header className="review-status" data-status={snapshot.status}>
      {snapshot.status === "loading" ? <span>Loading the review…</span> : null}
      {/* The diff below is still the one this review published; only the link dropped. */}
      {snapshot.status === "reconnecting" ? <span>Reconnecting to the review…</span> : null}
      {snapshot.status === "disconnected" ? <span>This review session has ended.</span> : null}
      {snapshot.failure ? (
        <span className="review-status-failure">{snapshot.failure.message}</span>
      ) : null}
    </header>
  );
}

/** The review's files, in review order, each linking to its place in the stream. */
function ReviewFileList({ files }: { files: readonly ReviewFileV1[] }) {
  return (
    <nav className="review-file-list" aria-label="Files in this review">
      <ol>
        {files.map((file) => {
          const badges = reviewFileStatBadges(file.stats);
          return (
            <li key={file.key}>
              <a href={`#${formatReviewAddress({ kind: "file", fileKey: file.key })}`}>
                <span className="review-file-list-path">{file.path}</span>
                {badges.additionsText ? (
                  <span className="review-stat review-stat-addition">{badges.additionsText}</span>
                ) : null}
                {badges.deletionsText ? (
                  <span className="review-stat review-stat-deletion">{badges.deletionsText}</span>
                ) : null}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
