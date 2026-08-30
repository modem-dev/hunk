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
import { reviewErrorMessage } from "../session/reviewErrorCatalog";
import { BrowserReviewApiClient, parseBrowserReviewLocation } from "./browserReviewApiClient";
import { BrowserReviewMirror } from "./browserReviewMirror";
import { BrowserReviewApp } from "./BrowserReviewApp";
import type { BrowserHostViewDefaults } from "./browserViewOptions";

/**
 * The host's resolved view defaults, when the page was served with them.
 *
 * Delivered with the document rather than over the wire: they are a fact about the session
 * that served the page, not about the review it publishes, and a publication that carried
 * them would make one client's window size look like review state (G1).
 */
declare global {
  interface Window {
    __hunkReviewViewDefaults?: BrowserHostViewDefaults;
  }
}

/** Mount the review page, or say why there is nothing to mount. */
export function mountBrowserReviewPage(container: HTMLElement) {
  const location = parseBrowserReviewLocation(new URL(window.location.href));
  if (!location) {
    // A link this client cannot read is one no session would honor, so it is the
    // catalog's `unauthorized` wording rather than a sentence written here (G4).
    container.textContent = reviewErrorMessage("unauthorized");
    return;
  }

  const client = new BrowserReviewApiClient(location);
  const mirror = new BrowserReviewMirror(client);
  createRoot(container).render(
    <BrowserReviewApp
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
  mountBrowserReviewPage(container);
}
