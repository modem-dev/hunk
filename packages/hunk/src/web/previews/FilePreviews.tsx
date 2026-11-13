/** @jsxImportSource react */
/**
 * The stream's preview slots: a header toggle for Markdown files, and a body that shows an
 * image preview or rendered Markdown in place of the default body when either applies.
 *
 * The stream renders these slots and knows nothing else about previews; everything they read
 * comes from `PreviewContext`, which the page provides.
 */
import { useContext, useSyncExternalStore, type ReactNode } from "react";
import type { ReviewFileV1 } from "../../core/review/types";
import { isPreviewImagePath } from "./imageSniff";
import { ImagePreview } from "./ImagePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { isMarkdownPath, markdownPreviewSide, PreviewContext } from "./previewContext";

/** Whether a Markdown file has the source a rendered view reads. */
function useMarkdownSource(fileKey: string, path: string, changeKind: string) {
  const context = useContext(PreviewContext);
  const side = markdownPreviewSide(changeKind);
  const available =
    isMarkdownPath(path) &&
    (context
      ?.resources(fileKey)
      .some((resource) => resource.kind === "source" && resource.side === side) ??
      false);
  useSyncExternalStore(
    context?.markdownModes.subscribe ?? noopSubscribe,
    context?.markdownModes.getVersion ?? zero,
  );
  return {
    context,
    side,
    available,
    rendered: available && (context?.markdownModes.isRendered(fileKey) ?? false),
  };
}

const noopSubscribe = () => () => {};
const zero = () => 0;

/**
 * The header control between a Markdown file's diff and its rendered text: two segments with the
 * one showing checked, in the same radio-group markup as the layout and image-mode controls.
 */
export function FilePreviewHeaderAction({
  fileKey,
  path,
  changeKind,
}: {
  fileKey: string;
  path: string;
  changeKind: string;
}) {
  const { context, available, rendered } = useMarkdownSource(fileKey, path, changeKind);
  if (!available || !context) return null;
  const modes = [
    { id: "diff", label: "Diff", title: "Show the diff", checked: !rendered },
    { id: "rendered", label: "Rendered", title: "Show the rendered document", checked: rendered },
  ] as const;
  return (
    <div
      className="segmented small markdown-mode"
      role="radiogroup"
      aria-label={`View ${path}`}
      data-testid="markdown-mode"
    >
      {modes.map((mode) => (
        <button
          key={mode.id}
          type="button"
          role="radio"
          aria-checked={mode.checked}
          data-testid={`markdown-mode-${mode.id}`}
          title={mode.title}
          onClick={() => {
            if (!mode.checked) context.markdownModes.toggle(fileKey);
          }}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}

/** The body: an image preview, rendered Markdown, or the stream's own body. */
export function FilePreviewBody({
  fileKey,
  file,
  emptyReason,
  mounted,
  children,
}: {
  fileKey: string;
  file: ReviewFileV1 | undefined;
  emptyReason: string | undefined;
  mounted: boolean;
  children: ReactNode;
}) {
  const markdown = useMarkdownSource(fileKey, file?.path ?? "", file?.changeKind ?? "change");
  if (!file || !mounted) return <>{children}</>;
  if (emptyReason === "binary" && file.flags.binary && isPreviewImagePath(file.path)) {
    return <ImagePreview path={file.path} fileKey={fileKey} fallback={children} />;
  }
  if (markdown.rendered) {
    return <MarkdownPreview fileKey={fileKey} side={markdown.side} fallback={children} />;
  }
  return <>{children}</>;
}
