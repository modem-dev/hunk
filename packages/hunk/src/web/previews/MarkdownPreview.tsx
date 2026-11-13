/** @jsxImportSource react */
/**
 * The rendered view of one Markdown file: its new text (its old text once deleted), read from
 * the file's `source` resource and rendered through the page's own inert Markdown renderer.
 *
 * A source larger than `MAX_MARKDOWN_PREVIEW_BYTES` is not parsed: the view says why and shows
 * the stream's own diff body beneath, so the toggle never leaves the file unreadable.
 */
import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ReviewSide } from "../../core/review/types";
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import { ReviewApiError } from "../transport/apiClient";
import { formatPreviewBytes } from "./ImagePreview";
import { MAX_MARKDOWN_PREVIEW_BYTES, parseMarkdown } from "./markdown";
import { MarkdownView } from "./MarkdownView";
import { PreviewContext } from "./previewContext";

type SourceText =
  | { status: "loading" }
  | { status: "ready"; text: string }
  | { status: "failed"; message: string }
  | { status: "too-large"; size: number };

/** The explanation shown above the diff when a document is too large to render. */
export function markdownTooLargeMessage(size: number) {
  return `Too large to render (${formatPreviewBytes(size)}; the limit is ${formatPreviewBytes(MAX_MARKDOWN_PREVIEW_BYTES)}). Showing the diff.`;
}

/** One file's rendered Markdown, or its diff (`fallback`) when the source is too large. */
export function MarkdownPreview({
  fileKey,
  side,
  fallback,
}: {
  fileKey: string;
  side: ReviewSide;
  fallback: ReactNode;
}) {
  const context = useContext(PreviewContext);
  const descriptor = context
    ?.resources(fileKey)
    .find((resource) => resource.kind === "source" && resource.side === side);
  // A declared size past the limit decides on the first render, before any read starts.
  const declaredTooLarge = (descriptor?.byteLength ?? 0) > MAX_MARKDOWN_PREVIEW_BYTES;
  const [source, setSource] = useState<SourceText>(() =>
    declaredTooLarge
      ? { status: "too-large", size: descriptor!.byteLength! }
      : { status: "loading" },
  );

  useEffect(() => {
    if (!context || !descriptor) {
      setSource({ status: "failed", message: reviewErrorMessage("unknown-resource") });
      return;
    }
    if ((descriptor.byteLength ?? 0) > MAX_MARKDOWN_PREVIEW_BYTES) {
      setSource({ status: "too-large", size: descriptor.byteLength! });
      return;
    }
    const controller = new AbortController();
    setSource({ status: "loading" });
    context
      .read(descriptor, controller.signal)
      .then((bytes) => {
        if (controller.signal.aborted) return;
        // The descriptor's size is advisory; the bytes actually read decide.
        if (bytes.byteLength > MAX_MARKDOWN_PREVIEW_BYTES) {
          setSource({ status: "too-large", size: bytes.byteLength });
          return;
        }
        setSource({ status: "ready", text: new TextDecoder().decode(bytes) });
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
  if (source.status === "too-large") {
    return (
      <>
        <p className="file-placeholder" role="status" data-testid="markdown-too-large">
          {markdownTooLargeMessage(source.size)}
        </p>
        {fallback}
      </>
    );
  }
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
