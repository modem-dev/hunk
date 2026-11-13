/** @jsxImportSource react */
/**
 * Renders the minimal browser review page: connection state, file count, and the first
 * file's diff through Pierre.
 *
 * Deliberately small. It exists so the served page, its content security policy, and
 * Pierre's web renderer are exercised in production code from the first milestone; the
 * read-only client replaces it with the full review stream.
 */
import { PatchDiff } from "@pierre/diffs/react";
import { useEffect, useState } from "react";
import { loadReviewShell, type ReviewShellResult } from "./reviewShellClient";

/** Pierre options for the preview: Hunk's default split layout, following the system theme. */
const PATCH_OPTIONS = {
  diffStyle: "split",
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
} as const;

/** Load the review once for this page's address and render what came back. */
export function ReviewShell() {
  const [result, setResult] = useState<ReviewShellResult | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void loadReviewShell(window.location).then((next) => {
      if (current) setResult(next);
    });
    return () => {
      current = false;
    };
  }, []);

  if (!result) {
    return (
      <main className="shell">
        <p className="status" data-state="loading" role="status">
          Connecting to the Hunk session…
        </p>
      </main>
    );
  }

  if (result.status === "failed") {
    return (
      <main className="shell">
        <p className="status" data-state="failed" role="alert">
          {result.message}
        </p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="toolbar">
        <span className="status" data-state="connected" role="status">
          Connected
        </span>
        <span className="file-count" data-testid="file-count">
          {result.fileCount === 1 ? "1 file" : `${result.fileCount} files`}
        </span>
      </header>
      {result.firstPatch ? (
        <section className="diff" data-testid="first-file-diff">
          <PatchDiff patch={result.firstPatch} options={PATCH_OPTIONS} />
        </section>
      ) : null}
    </main>
  );
}
