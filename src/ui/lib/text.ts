/** Clamp text to a fixed width using a plain-dot terminal fallback marker. */
export function fitText(text: string, width: number) {
  if (width <= 0) {
    return "";
  }

  if (text.length <= width) {
    return text;
  }

  if (width === 1) {
    return ".";
  }

  return `${text.slice(0, width - 1)}.`;
}

/** Clamp and then right-pad text to an exact width. */
export function padText(text: string, width: number) {
  const trimmed = fitText(text, width);
  return trimmed.padEnd(width, " ");
}
