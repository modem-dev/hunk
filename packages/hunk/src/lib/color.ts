/** One parsed RGB triplet from a #rrggbb hex color. */
interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Parse a #rrggbb color into RGB components. Falls back to black for invalid input. */
function hexToRgb(hex: string): RgbColor {
  const normalized = /^#?[0-9a-f]{6}$/i.test(hex) ? hex.replace(/^#/, "") : "000000";
  const value = parseInt(normalized, 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

/** Blend one foreground color toward a background color at a fixed ratio. */
export function blendHex(fg: string, bg: string, ratio: number) {
  const foreground = hexToRgb(fg);
  const background = hexToRgb(bg);
  const mix = (front: number, back: number) =>
    Math.max(0, Math.min(255, Math.round(back + (front - back) * ratio)));

  return `#${(
    (mix(foreground.r, background.r) << 16) |
    (mix(foreground.g, background.g) << 8) |
    mix(foreground.b, background.b)
  )
    .toString(16)
    .padStart(6, "0")}`;
}

/** Convert one sRGB channel into linear-light space for WCAG contrast math. */
function linearizedChannel(channel: number) {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Return the WCAG relative luminance for a #rrggbb color. */
export function relativeLuminance(hex: string) {
  const color = hexToRgb(hex);
  return (
    0.2126 * linearizedChannel(color.r) +
    0.7152 * linearizedChannel(color.g) +
    0.0722 * linearizedChannel(color.b)
  );
}

/** Return the WCAG contrast ratio between two #rrggbb colors. */
export function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Measure how visually separated two #rrggbb colors are using channel deltas. */
export function hexColorDistance(left: string, right: string) {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}
