/** @jsxImportSource react */
/**
 * Starts the browser review client the daemon serves at `/review/<session>/`.
 *
 * `scripts/build/build-web.ts` bundles this entry into the page's hashed assets; it runs
 * under the page's content security policy, so it loads nothing but its own chunks and
 * talks only to this origin's review API.
 */
import { createRoot } from "react-dom/client";
import { ReviewShell } from "./ReviewShell";
import "./styles.css";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<ReviewShell />);
}
