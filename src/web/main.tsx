/** @jsxImportSource react */
import { createRoot } from "react-dom/client";
import { WebReviewApp } from "./App";
import { BrowserReviewApiClient, BrowserReviewApiError } from "./lib/apiClient";

const mount = globalThis.document?.getElementById("app");
if (!mount) throw new Error("Browser review mount is missing.");

const fragment = new URLSearchParams(location.hash.slice(1));
const capability = fragment.get("capability");
history.replaceState(null, "", location.pathname + location.search);
const sessionId = parseSessionId(location.pathname);
const root = createRoot(mount);

if (!sessionId) {
  root.render(
    <StartupFailure
      title="Review link is incomplete"
      body="This local review link does not identify a review session."
    />,
  );
} else {
  root.render(<StartupStatus>Authenticating local review…</StartupStatus>);
  // The first navigation exchanges the fragment capability. Later refreshes have only the
  // scoped HttpOnly cookie, so retry the snapshot directly instead of requiring the removed hash.
  const api = capability
    ? BrowserReviewApiClient.authenticate(sessionId, capability)
    : Promise.resolve(new BrowserReviewApiClient(sessionId));
  void api
    .then(async (client) => ({ api: client, snapshot: await client.snapshot() }))
    .then(({ api: client, snapshot }) =>
      root.render(<WebReviewApp api={client} initialSnapshot={snapshot} />),
    )
    .catch((error) => {
      const expired = error instanceof BrowserReviewApiError && error.status === 401;
      root.render(
        <StartupFailure
          title={expired ? "Review link expired" : "Review unavailable"}
          body={error instanceof Error ? error.message : "The local review could not be loaded."}
        />,
      );
    });
}

function parseSessionId(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "review") return "";
  try {
    return decodeURIComponent(parts[1]!);
  } catch {
    return "";
  }
}

function StartupStatus({ children }: { children: string }) {
  return (
    <main className="startup-state" aria-live="polite">
      <span className="wordmark">Hunk</span>
      <p>{children}</p>
    </main>
  );
}

function StartupFailure({ title, body }: { title: string; body: string }) {
  return (
    <main className="startup-state startup-state--error" role="alert">
      <span className="wordmark">Hunk</span>
      <h1>{title}</h1>
      <p>{body}</p>
    </main>
  );
}
