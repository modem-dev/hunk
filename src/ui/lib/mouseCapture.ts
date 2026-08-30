import type { CliRenderer, Renderable } from "@opentui/core";

type MouseCaptureRenderer = {
  setCapturedRenderable: (renderable: Renderable | undefined) => void;
};

/** Keep a mouse gesture on a persistent renderable, or release that capture. */
export function setMouseCapture(renderer: CliRenderer, renderable: Renderable | undefined) {
  // OpenTUI has no public pointer-capture API yet. Without this internal seam it captures the
  // renderable under the first drag event, which may be replaced while the gesture is active.
  (renderer as unknown as MouseCaptureRenderer).setCapturedRenderable(renderable);
}
