/** @jsxImportSource react */
/**
 * Renders the minimal browser review page: connection state, load progress, file count,
 * and the first file's diff through Pierre.
 *
 * Deliberately small: it exists so the served page, its content security policy, and
 * Pierre's web renderer run on the real transport, mirror, and store. The review stream
 * replaces it.
 */
import { PatchDiff } from "@pierre/diffs/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { reviewErrorMessage } from "../session/reviewErrorCatalog";
import {
  reviewFailureMessage,
  startReviewSession,
  type ReviewSession,
} from "./session/reviewSession";

/** Pierre options for the preview: Hunk's default split layout, following the system theme. */
const PATCH_OPTIONS = {
  diffStyle: "split",
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
} as const;

/** Start the review for this page's address once, and stop it on unmount. */
function useReviewSessionStart() {
  const [start] = useState(() => startReviewSession({ location: window.location }));
  useEffect(() => (start.ok ? () => start.session.close() : undefined), [start]);
  return start;
}

/** Render one running session's state. */
function ReviewSessionView({ session }: { session: ReviewSession }) {
  const mirror = useSyncExternalStore(session.mirror.subscribe, session.mirror.getSnapshot);
  const connection = useSyncExternalStore(session.connection.subscribe, session.connection.get);
  const review = useSyncExternalStore(
    session.review.store.subscribe,
    session.review.store.getSnapshot,
  );

  if (connection.kind === "ended" && connection.reason === "refused") {
    return (
      <p className="status" data-state="failed" role="alert">
        {reviewErrorMessage(connection.code === "unauthorized" ? "unauthorized" : "no-publication")}
      </p>
    );
  }
  if (mirror.status === "failed") {
    return (
      <p className="status" data-state="failed" role="alert">
        {reviewFailureMessage(mirror.error)}
      </p>
    );
  }
  if (mirror.status === "waiting") {
    return (
      <p className="status" data-state="loading" role="status">
        Connecting to the Hunk session…
      </p>
    );
  }

  const firstFile = review.document.files[0];
  return (
    <>
      <header className="toolbar">
        <span className="status" data-state="connected" role="status">
          {connection.kind === "reconnecting" ? "Reconnecting…" : "Connected"}
        </span>
        <span className="file-count" data-testid="file-count">
          {mirror.totalFiles === 1 ? "1 file" : `${mirror.totalFiles} files`}
        </span>
        {mirror.status === "loading" ? (
          <span className="progress" data-testid="load-progress">
            {`Loaded ${mirror.loadedFiles} of ${mirror.totalFiles}`}
          </span>
        ) : null}
      </header>
      {firstFile?.patch ? (
        <section className="diff" data-testid="first-file-diff">
          <PatchDiff patch={firstFile.patch} options={PATCH_OPTIONS} />
        </section>
      ) : null}
    </>
  );
}

/** The page: either the running review or why it could not start. */
export function ReviewShell() {
  const start = useReviewSessionStart();
  return (
    <main className="shell">
      {start.ok ? (
        <ReviewSessionView session={start.session} />
      ) : (
        <p className="status" data-state="failed" role="alert">
          {start.message}
        </p>
      )}
    </main>
  );
}
