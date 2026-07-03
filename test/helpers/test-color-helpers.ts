/** Convert captured RGBA output back into a #rrggbb color string for render assertions. */
export function capturedTestColorToHex(color: { buffer?: ArrayLike<number> } | undefined) {
  const buffer = color?.buffer;
  if (!buffer || buffer[0] == null || buffer[1] == null || buffer[2] == null) {
    return null;
  }

  const componentToHex = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0");

  return `#${componentToHex(buffer[0])}${componentToHex(buffer[1])}${componentToHex(buffer[2])}`;
}
