/** Clamp one source translation so scaled content stays inside its viewport. */
function projectAxis(viewportSize, sourceSize, focus, scale) {
  const scaledSize = sourceSize * scale;
  if (scaledSize <= viewportSize) return 0;
  const requested = viewportSize / 2 - focus * scaledSize;
  return Math.min(0, Math.max(viewportSize - scaledSize, requested));
}

/**
 * Project normalized source geometry through a camera into the terminal viewport.
 * Source dimensions describe the rendered capture, excluding any sampled filler.
 */
export function projectTerminalFocus({
  camera,
  highlight,
  sourceHeight,
  sourceWidth,
  viewportHeight,
  viewportWidth,
}) {
  const activeCamera = camera ?? { x: 0.5, y: 0.5, scale: 1 };
  const width = sourceWidth > 0 ? sourceWidth : viewportWidth;
  const height = sourceHeight > 0 ? sourceHeight : viewportHeight;
  const translateX = projectAxis(viewportWidth, width, activeCamera.x, activeCamera.scale);
  const translateY = projectAxis(viewportHeight, height, activeCamera.y, activeCamera.scale);

  return {
    translateX,
    translateY,
    scale: activeCamera.scale,
    highlight: highlight
      ? {
          x: translateX + highlight.x * width * activeCamera.scale,
          y: translateY + highlight.y * height * activeCamera.scale,
          width: highlight.width * width * activeCamera.scale,
          height: highlight.height * height * activeCamera.scale,
        }
      : null,
  };
}
