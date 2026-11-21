/** @jsxImportSource react */
/**
 * Starts the browser review client the daemon serves at `/review/<session>/`.
 *
 * `scripts/build/build-web.ts` bundles this entry into the page's hashed assets; it runs
 * under the page's content security policy, so it loads nothing but its own chunks and data
 * and talks only to this origin's review API. The session for this page's address is
 * started once and stopped when the page goes away.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReviewApp } from "./app/ReviewApp";
import { startReviewSession } from "./session/reviewSession";
import "./styles.css";

/** This tab's storage, or nothing where the browser refuses it. */
function pageStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Start the review this page was opened for, or say why it cannot start. */
function ReviewRoot() {
  const [start] = useState(() =>
    startReviewSession({
      location: window.location,
      history: window.history,
      ...(pageStorage() ? { storage: pageStorage()! } : {}),
    }),
  );
  useEffect(() => (start.ok ? () => start.session.close() : undefined), [start]);
  return start.ok ? (
    <ReviewApp session={start.session} />
  ) : (
    <p className="status page-message" data-state="failed" role="alert">
      {start.message}
    </p>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<ReviewRoot />);
}
