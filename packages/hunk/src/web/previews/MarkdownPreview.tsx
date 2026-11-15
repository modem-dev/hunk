/** @jsxImportSource react */
/**
 * The rendered view of one Markdown file: its new text (its old text once deleted), read from
 * the file's `source` resource and rendered through the page's own inert Markdown renderer.
 */
import { useContext, useEffect, useMemo, useState } from "react";
import type { ReviewSide } from "../../core/review/types";
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import { ReviewApiError } from "../transport/apiClient";
import { parseMarkdown } from "./markdown";
import { MarkdownView } from "./MarkdownView";
import { PreviewContext } from "./previewContext";

type SourceText =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "failed"; message: string };

/** One file's rendered Markdown. */
export function MarkdownPreview({ fileKey, side }: { fileKey: string; side: ReviewSide }) {
  const context = useContext(PreviewContext);
  const [source, setSource] = useState<SourceText>({ status: "loading" });
  const descriptor = context
    ?.resources(fileKey)
    .find((resource) => resource.kind === "source" && resource.side === side);

  useEffect(() => {
    if (!context || !descriptor) {
      setSource({ status: "failed", message: reviewErrorMessage("unknown-resource") });
      return;
    }
    const controller = new AbortController();
    setSource({ status: "loading" });
    context
      .read(descriptor, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) {
          setSource({ status: "ready", text: new TextDecoder().decode(bytes) });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSource({
          status: "failed",
          message:
            error instanceof ReviewApiError &&
            error.code !== "network" &&
            error.code !== "unreadable"
              ? reviewErrorMessage(error.code)
              : reviewErrorMessage("resource-unavailable"),
        });
      });
    return () => controller.abort();
  }, [context, descriptor]);

  const document = useMemo(
    () => (source.status === "ready" ? parseMarkdown(source.text) : []),
    [source],
  );
  if (source.status === "loading") return <p className="file-placeholder">Loading Markdown…</p>;
  if (source.status === "failed") {
    return (
      <p className="file-placeholder" role="status">
        {source.message}
      </p>
    );
  }
  return (
    <div className="markdown-preview" data-testid="markdown-preview" data-side={side}>
      <MarkdownView document={document} />
    </div>
  );
}
