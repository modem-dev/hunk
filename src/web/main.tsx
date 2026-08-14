/** @jsxImportSource react */
/**
 * The browser review page's entry point.
 *
 * Three things happen here and nowhere else: the review URL is read, the client and mirror
 * are built from it, and the page is mounted. Everything after that is the mirror's.
 *
 * The language registration import is a side effect, and a deliberate one: Hunk registers
 * file extensions Pierre's own inference does not know (`.mts`, `.cts`), and the prototype
 * browser never imported the module that does it — so the same file highlighted one way in
 * a terminal and another in a browser (`docs/browser-review-seam-audit.md`, A11). Importing
 * it before anything renders is what makes the two agree.
 */
import { createRoot } from "react-dom/client";
import "../core/changeset/fileLanguage";
import { ReviewApiClient, parseReviewLocation } from "./reviewApiClient";
import { ReviewMirror } from "./reviewMirror";
import { ReviewApp } from "./ReviewApp";
import type { HostViewDefaults } from "./viewOptions";

/**
 * The host's resolved view defaults, when the page was served with them.
 *
 * Delivered with the document rather than over the wire: they are a fact about the session
 * that served the page, not about the review it publishes, and a publication that carried
 * them would make one client's window size look like review state (G1).
 */
declare global {
  interface Window {
    __hunkReviewViewDefaults?: HostViewDefaults;
  }
}

/** Mount the review page, or say why there is nothing to mount. */
export function mountReviewPage(container: HTMLElement) {
  const location = parseReviewLocation(new URL(window.location.href));
  if (!location) {
    container.textContent =
      "This review link is incomplete. Open the review from the terminal running it to get a current link.";
    return;
  }

  const client = new ReviewApiClient(location);
  const mirror = new ReviewMirror(client);
  createRoot(container).render(
    <ReviewApp
      mirror={mirror}
      client={client}
      {...(window.__hunkReviewViewDefaults
        ? { hostViewDefaults: window.__hunkReviewViewDefaults }
        : {})}
    />,
  );
}

const container = document.getElementById("hunk-review");
if (container) {
  mountReviewPage(container);
}
