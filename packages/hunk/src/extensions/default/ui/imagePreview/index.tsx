/**
 * Registers Hunk's "Image preview" file view: a changed PNG, JPEG, GIF, or WebP file is drawn
 * before and after the change inline in the review stream, where the raw diff otherwise shows
 * "Binary file skipped". Like every file view it is opt-in per file: press `i` on an image, or
 * choose it under View → File presentation, and "Apply … to all matching files" covers the rest.
 *
 * Both versions come from `input.readBytes`, so the preview shows exactly the bytes the review
 * source names (a commit, the index, the working tree) through any VCS adapter that implements
 * `readFileBytes`. When neither side can be read, the view declines and the raw diff stays.
 */

import type {
  ExtensionFileSide,
  ExtensionFileViewInput,
  ExtensionFileViewRowComponentProps,
} from "../../../../extension-api/types";
import type { ExtensionFactory } from "../../../types";
import { layoutImagePair, SIDE_GAP, type ImagePainter, type ImageSideState } from "./layout";

export const BUNDLED_IMAGE_PREVIEW_VIEW_ID = "image-preview";
export const BUNDLED_IMAGE_PREVIEW_TOGGLE_COMMAND_ID = "imagePreview.toggle";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Return whether a path names an image format the terminal renderer can decode. */
export function isPreviewableImagePath(path: string) {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** Paint one image, or two side by side, across a fixed-height row. */
const paintImages: ImagePainter = (images) =>
  function ImagePreviewRow({ width, height }: ExtensionFileViewRowComponentProps) {
    const columns = images.length > 1 ? Math.floor((width - SIDE_GAP) / 2) : width;
    return (
      <box flexDirection="row" gap={SIDE_GAP} width={width} height={height}>
        {images.map((bytes, index) =>
          bytes ? (
            <image key={index} source={bytes} fit="fit" width={columns} height={height} />
          ) : null,
        )}
      </box>
    );
  };

/** Load one side, or mark it absent when the change added or deleted the image. */
async function readImageSide(
  input: ExtensionFileViewInput,
  side: ExtensionFileSide,
): Promise<ImageSideState> {
  const absent = side === "old" ? "new" : "deleted";
  if (input.file.changeType === absent) return { kind: "absent" };

  const bytes = await input.readBytes(side);
  return bytes
    ? { kind: "loaded", bytes }
    : { kind: "failed", reason: "this review source cannot supply the image" };
}

const registerBundledImagePreview: ExtensionFactory = (hunk) => {
  hunk.registerFileView({
    id: BUNDLED_IMAGE_PREVIEW_VIEW_ID,
    title: "Image preview",
    matches: (file) => file.isBinary === true && isPreviewableImagePath(file.path),
    async layout(input) {
      // An image Git could diff as text has hunks this view cannot map; the raw diff stays.
      if ((input.file.hunks?.length ?? 0) > 0) return null;

      const [before, after] = await Promise.all([
        readImageSide(input, "old"),
        readImageSide(input, "new"),
      ]);
      if (before.kind !== "loaded" && after.kind !== "loaded") return null;

      return { rows: layoutImagePair({ before, after }, input.width, paintImages), hunkRows: [] };
    },
  });

  hunk.registerCommand(
    { id: BUNDLED_IMAGE_PREVIEW_TOGGLE_COMMAND_ID, title: "Toggle image preview", key: "i" },
    (ctx) => {
      ctx.fileViews.toggle(BUNDLED_IMAGE_PREVIEW_VIEW_ID);
    },
  );
};

export default registerBundledImagePreview;
