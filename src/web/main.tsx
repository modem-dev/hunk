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

if (!sessionId || !capability) {
  root.render(
    <StartupFailure
      title="Review link is incomplete"
      body="This local review link is missing its authorization capability."
    />,
  );
} else {
  root.render(<StartupStatus>Authenticating local review…</StartupStatus>);
  void BrowserReviewApiClient.authenticate(sessionId, capability)
    .then(async (api) => ({ api, snapshot: await api.snapshot() }))
    .then(({ api, snapshot }) => root.render(<WebReviewApp api={api} initialSnapshot={snapshot} />))
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
