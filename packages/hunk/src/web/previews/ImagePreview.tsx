/** @jsxImportSource react */
/**
 * Previews a binary image file in place of "Binary file skipped": side by side, swipe, or
 * onion skin, with dimensions and byte sizes, over a checkerboard for transparency. An added or
 * deleted image shows its one side. Swipe and onion skin draw both images at one scale,
 * anchored top-left, so images of different sizes overlay at their true relative size.
 *
 * Each side's `bytes` resource is read whole (refused past `MAX_REVIEW_BYTES_RESOURCE_BYTES`),
 * its type is sniffed from its first bytes (`./imageSniff.ts`, raster formats only), and its
 * header dimensions are read and checked against `PREVIEW_IMAGE_LIMITS` before anything is
 * decoded. Only then does it become a `Blob` with that allow-listed type and a `blob:` URL,
 * shown only through `<img>` and revoked on unmount. Bytes that are not an accepted image, or
 * whose size cannot be read, or that the browser cannot decode, fall back to the stream's own
 * placeholder; an image past the limits shows the placeholder with its size.
 */
import { useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  MAX_REVIEW_BYTES_RESOURCE_BYTES,
  type ReviewResourceDescriptorV1,
} from "../../core/review/resources";
import type { ReviewSide } from "../../core/review/types";
import { reviewErrorMessage } from "../../session/reviewErrorCatalog";
import { ReviewApiError } from "../transport/apiClient";
import {
  headerImageSize,
  PREVIEW_IMAGE_MIMES,
  previewDisplaySize,
  previewImageRefusal,
  sniffPreviewImageMime,
} from "./imageSniff";
import { PreviewContext } from "./previewContext";

type SideImage =
  | { status: "loading" }
  | { status: "ready"; url: string; mime: string; size: number; width: number; height: number }
  | { status: "failed"; message: string }
  | { status: "too-large"; message: string }
  | { status: "not-image" };

type ImageMode = "side-by-side" | "swipe" | "onion";

const MODES: readonly [ImageMode, string][] = [
  ["side-by-side", "Side by side"],
  ["swipe", "Swipe"],
  ["onion", "Onion skin"],
];

/** A byte count for people. */
export function formatPreviewBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Read, sniff, and wrap one side's bytes. */
function useSideImage(descriptor: ReviewResourceDescriptorV1 | undefined): SideImage | undefined {
  const context = useContext(PreviewContext);
  const [image, setImage] = useState<SideImage | undefined>(
    descriptor ? { status: "loading" } : undefined,
  );
  useEffect(() => {
    if (!descriptor || !context) return;
    if ((descriptor.byteLength ?? 0) > MAX_REVIEW_BYTES_RESOURCE_BYTES) {
      setImage({ status: "failed", message: reviewErrorMessage("resource-too-large") });
      return;
    }
    const controller = new AbortController();
    let url: string | undefined;
    setImage({ status: "loading" });
    context
      .read(descriptor, controller.signal)
      .then((bytes) => {
        if (controller.signal.aborted) return;
        const mime = sniffPreviewImageMime(bytes);
        const dimensions = mime ? headerImageSize(bytes, mime) : undefined;
        // An unknown type, or a size the header does not state, is never decoded.
        if (!mime || !dimensions || !PREVIEW_IMAGE_MIMES.has(mime)) {
          setImage({ status: "not-image" });
          return;
        }
        const refusal = previewImageRefusal(dimensions);
        if (refusal) {
          setImage({ status: "too-large", message: refusal });
          return;
        }
        url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
        setImage({ status: "ready", url, mime, size: bytes.byteLength, ...dimensions });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setImage({
          status: "failed",
          message:
            error instanceof ReviewApiError &&
            error.code !== "network" &&
            error.code !== "unreadable"
              ? reviewErrorMessage(error.code)
              : reviewErrorMessage("resource-unavailable"),
        });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [descriptor, context]);
  return image;
}

/** One side's caption: which side, dimensions, and size. */
function caption(label: string, image: Extract<SideImage, { status: "ready" }>) {
  return [label, `${image.width} × ${image.height}`, formatPreviewBytes(image.size)].join(" · ");
}

export interface ImagePreviewProps {
  path: string;
  fileKey: string;
  /** What the stream shows when there is nothing to preview. */
  fallback: ReactNode;
}

/** The image preview for one binary file. */
export function ImagePreview({ path, fileKey, fallback }: ImagePreviewProps) {
  const context = useContext(PreviewContext);
  const descriptors = context?.resources(fileKey) ?? [];
  const bytesFor = (side: ReviewSide) =>
    descriptors.find((resource) => resource.kind === "bytes" && resource.side === side);
  const oldImage = useSideImage(bytesFor("old"));
  const newImage = useSideImage(bytesFor("new"));
  const [mode, setMode] = useState<ImageMode>("side-by-side");
  const [position, setPosition] = useState(50);
  // Keyed by the image's `blob:` URL, not its side: a refresh with changed bytes makes a new
  // URL, so old dimensions and an old decode failure never outlive the bytes they were for.
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [undecodable, setUndecodable] = useState<ReadonlySet<string>>(() => new Set());

  const sides = [
    { side: "old" as const, label: "Before", image: oldImage },
    { side: "new" as const, label: "After", image: newImage },
  ].filter((entry) => entry.image !== undefined);
  if (
    sides.length === 0 ||
    sides.some(
      (entry) =>
        entry.image!.status === "not-image" ||
        (entry.image!.status === "ready" && undecodable.has(entry.image!.url)),
    )
  ) {
    return <>{fallback}</>;
  }
  const tooLarge = sides.find((entry) => entry.image!.status === "too-large");
  if (tooLarge) {
    return (
      <p className="file-placeholder" role="status" data-testid="image-preview-too-large">
        {(tooLarge.image as Extract<SideImage, { status: "too-large" }>).message}
      </p>
    );
  }
  const failed = sides.find((entry) => entry.image!.status === "failed");
  if (failed) {
    return (
      <p className="file-placeholder" role="status" data-testid="image-preview-error">
        {(failed.image as Extract<SideImage, { status: "failed" }>).message}
      </p>
    );
  }
  if (sides.some((entry) => entry.image!.status !== "ready")) {
    return <p className="file-placeholder">Loading image…</p>;
  }
  const ready = sides.map((entry) => {
    const image = entry.image as Extract<SideImage, { status: "ready" }>;
    // The decoded size wins once known: a JPEG's EXIF orientation can swap its header's axes.
    const size = measured[image.url];
    return { ...entry, image: size ? { ...image, width: size.width, height: size.height } : image };
  });
  const single = ready.length === 1;
  const label = (entry: (typeof ready)[number]) =>
    single ? (entry.side === "old" ? "Deleted" : "Added") : entry.label;
  // Both sides share one drawing box in the stacked modes, sized from the larger image, so swipe
  // and onion skin line up pixel for pixel; side by side, each side gets its own size.
  const boxFor = (sides: typeof ready) => {
    const width = Math.max(...sides.map((entry) => entry.image.width));
    const height = Math.max(...sides.map((entry) => entry.image.height));
    return previewDisplaySize(width, height);
  };
  // Stacked, each image keeps its size relative to the other: both are drawn at the box's one
  // scale and anchored at the top-left corner, where their pixel coordinates both start.
  const stackedSize = (entry: (typeof ready)[number], box: { width: number }) => {
    const widest = Math.max(...ready.map((other) => other.image.width));
    const scale = widest > 0 ? box.width / widest : 0;
    return {
      width: Math.round(entry.image.width * scale),
      height: Math.round(entry.image.height * scale),
    };
  };
  const img = (
    entry: (typeof ready)[number],
    box: { width: number; height: number },
    className?: string,
    style?: CSSProperties,
  ) => (
    <img
      className={className}
      style={{ ...(box.width > 0 ? { width: box.width, height: box.height } : {}), ...style }}
      src={entry.image.url}
      alt={`${label(entry)}: ${path}`}
      draggable={false}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget;
        const url = entry.image.url;
        setMeasured((current) =>
          current[url]
            ? current
            : { ...current, [url]: { width: naturalWidth, height: naturalHeight } },
        );
      }}
      onError={() => setUndecodable((current) => new Set(current).add(entry.image.url))}
    />
  );

  const shownMode = single ? "side-by-side" : mode;
  return (
    <div className="image-preview" data-testid="image-preview" data-mode={shownMode}>
      {single ? null : (
        <div className="image-preview-controls">
          <div className="segmented small" role="radiogroup" aria-label="Image comparison">
            {MODES.map(([value, text]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                data-testid={`image-mode-${value}`}
                onClick={() => setMode(value)}
              >
                {text}
              </button>
            ))}
          </div>
          {mode === "side-by-side" ? null : (
            <label className="image-preview-slider">
              <span>{mode === "swipe" ? "Swipe" : "Opacity"}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={position}
                aria-label={mode === "swipe" ? "Swipe position" : "After opacity"}
                data-testid="image-slider"
                onChange={(event) => setPosition(Number(event.target.value))}
              />
            </label>
          )}
        </div>
      )}
      {shownMode === "side-by-side" ? (
        <div className="image-preview-sides">
          {ready.map((entry) => (
            <figure key={entry.side} className="image-preview-figure" data-side={entry.side}>
              <div className="image-preview-canvas">{img(entry, boxFor([entry]))}</div>
              <figcaption>{caption(label(entry), entry.image)}</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <figure className="image-preview-figure">
          <div className="image-preview-canvas">
            <div
              className="image-preview-stack"
              style={{ width: boxFor(ready).width, height: boxFor(ready).height }}
            >
              {img(ready[0]!, stackedSize(ready[0]!, boxFor(ready)))}
              {img(
                ready[1]!,
                stackedSize(ready[1]!, boxFor(ready)),
                "image-preview-over",
                mode === "swipe"
                  ? {
                      // The divider sits at a share of the box; the after image's clip is that
                      // same x, as a share of its own width.
                      clipPath: `inset(0 0 0 ${Math.min(
                        100,
                        (position * boxFor(ready).width) /
                          Math.max(1, stackedSize(ready[1]!, boxFor(ready)).width),
                      )}%)`,
                    }
                  : { opacity: position / 100 },
              )}
              {mode === "swipe" ? (
                <span
                  className="image-preview-divider"
                  style={{ left: `${position}%` }}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          </div>
          <figcaption>
            {caption("Before", ready[0]!.image)} — {caption("After", ready[1]!.image)}
          </figcaption>
        </figure>
      )}
    </div>
  );
}
