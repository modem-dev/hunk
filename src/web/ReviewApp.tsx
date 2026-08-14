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
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { formatReviewAddress } from "../core/review/address";
import { reviewExpansionSide } from "../core/review/expansion";
import { reviewFileStatBadges } from "../core/review/presentation";
import { reviewResourceId } from "../core/review/resources";
import type { ReviewFileV1 } from "../core/review/types";
import type { ReviewApiClient } from "./reviewApiClient";
import type { ReviewMirror, ReviewMirrorSnapshot } from "./reviewMirror";
import { ReviewStream } from "./ReviewStream";
import {
  resolveBrowserViewOptions,
  type BrowserViewOptions,
  type HostViewDefaults,
} from "./viewOptions";

export interface ReviewAppProps {
  mirror: ReviewMirror;
  client: ReviewApiClient;
  /** The host's resolved view defaults, when the page was served with them (G1). */
  hostViewDefaults?: HostViewDefaults;
}

/** Watch one mirror as a React store, without copying its state into component state. */
function useReviewMirror(mirror: ReviewMirror): ReviewMirrorSnapshot {
  return useSyncExternalStore(
    useCallback((notify) => mirror.subscribe(notify), [mirror]),
    useCallback(() => mirror.getSnapshot(), [mirror]),
    useCallback(() => mirror.getSnapshot(), [mirror]),
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

export function ReviewApp({ mirror, client, hostViewDefaults }: ReviewAppProps) {
  const snapshot = useReviewMirror(mirror);
  const viewportWidth = useViewportWidth();
  const [view] = useState<BrowserViewOptions>(() => resolveBrowserViewOptions(hostViewDefaults));
  const [sourceByFileKey, setSourceByFileKey] = useState<Record<string, string>>({});

  useEffect(() => {
    mirror.start();
    return () => mirror.stop();
  }, [mirror]);

  // A generation change invalidates every source it was read for: the same file key over
  // new content is different text.
  const generation = snapshot.publication?.generation;
  useEffect(() => {
    setSourceByFileKey({});
  }, [generation]);

  const requestSource = useCallback(
    (file: ReviewFileV1) => {
      if (!generation || file.sourceIdentity === undefined) {
        return;
      }
      void client
        .readResource({
          id: reviewResourceId({
            kind: "source",
            fileKey: file.key,
            side: reviewExpansionSide(file.changeKind),
          }),
          generation,
          kind: "source",
        })
        .then((result) => {
          if (result.ok) {
            setSourceByFileKey((sources) => ({
              ...sources,
              [file.key]: new TextDecoder().decode(result.value),
            }));
          }
        });
    },
    [client, generation],
  );

  return (
    <div className="review-app">
      <ReviewStatus snapshot={snapshot} />
      {snapshot.document ? (
        <div className="review-body">
          <ReviewFileList files={snapshot.document.files} />
          <ReviewStream
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
function ReviewStatus({ snapshot }: { snapshot: ReviewMirrorSnapshot }) {
  return (
    <header className="review-status" data-status={snapshot.status}>
      {snapshot.status === "loading" ? <span>Loading the review…</span> : null}
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
