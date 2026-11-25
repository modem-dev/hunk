/** @jsxImportSource react */
/**
 * The stream's preview slots: a header toggle for Markdown files, a binary file's byte sizes
 * for its header chip, and a body that shows an image preview or rendered Markdown in place of
 * the default body when either applies.
 *
 * The stream renders these slots and knows nothing else about previews; everything they read
 * comes from `PreviewContext`, which the page provides.
 */
import { useContext, useSyncExternalStore, type ReactNode } from "react";
import { revealReviewHiddenText } from "../../core/review/hiddenText";
import type { ReviewFile } from "../../core/review/types";
import { Icon, type IconName } from "../icons/Icon";
import { isPreviewImagePath } from "./imageSniff";
import { formatPreviewBytes, ImagePreview } from "./ImagePreview";
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
  const modes: readonly {
    id: "diff" | "rendered";
    label: string;
    icon: IconName;
    title: string;
    checked: boolean;
  }[] = [
    { id: "diff", label: "Diff", icon: "code", title: "Show the diff", checked: !rendered },
    {
      id: "rendered",
      label: "Rendered",
      icon: "eye",
      title: "Show the rendered document",
      checked: rendered,
    },
  ];
  return (
    <div
      className="segmented icon-segmented markdown-mode"
      role="radiogroup"
      aria-label={`View ${revealReviewHiddenText(path)}`}
      data-testid="markdown-mode"
    >
      {modes.map((mode) => (
        <button
          key={mode.id}
          type="button"
          role="radio"
          aria-checked={mode.checked}
          data-testid={`markdown-mode-${mode.id}`}
          aria-label={mode.label}
          title={mode.title}
          onClick={() => {
            if (!mode.checked) context.markdownModes.toggle(fileKey);
          }}
        >
          <Icon name={mode.icon} size={14} />
        </button>
      ))}
    </div>
  );
}

/**
 * A binary file's byte sizes as the page's resource catalog already states them
 * (`135 B → 127 B`, or one size for an added or deleted file); nothing is read to learn them.
 */
export function useBinaryFileSizes(fileKey: string, binary: boolean): string | undefined {
  const context = useContext(PreviewContext);
  if (!binary || !context) return undefined;
  const sizes = (["old", "new"] as const).flatMap((side) => {
    const bytes = context
      .resources(fileKey)
      .find((resource) => resource.kind === "bytes" && resource.side === side);
    return bytes?.byteLength !== undefined ? [formatPreviewBytes(bytes.byteLength)] : [];
  });
  return sizes.length > 0 ? sizes.join(" → ") : undefined;
}

/**
 * Whether a file that renders no rows still has a body to show: an image preview may stand in
 * for a binary image, and a too-large file says why it is not drawn. Every other such file is
 * a header-only row whose state chip explains it.
 */
export function emptyFileHasBody(file: ReviewFile, emptyReason: string) {
  if (emptyReason === "too-large") return true;
  return emptyReason === "binary" && file.flags.binary && isPreviewImagePath(file.path);
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
  file: ReviewFile | undefined;
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
