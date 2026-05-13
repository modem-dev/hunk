/** Stable, order-independent hash of an author string → palette index.
 * Uses FNV-1a (32-bit) for low collisions on short identifiers. */
function hashAuthor(author: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < author.length; i++) {
    h ^= author.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Resolve the accent color a given author should use against a palette.
 * Returns null when the author is absent or the palette is empty so callers
 * can fall back to theme defaults. */
export function resolveAuthorAccent(
  author: string | undefined,
  palette: readonly string[],
): string | null {
  if (!author || palette.length === 0) return null;
  const trimmed = author.trim();
  if (trimmed.length === 0) return null;
  const index = hashAuthor(trimmed) % palette.length;
  return palette[index] ?? null;
}

type Hsl = readonly [number, number, number];
type Rgb = readonly [number, number, number];

function hexToRgb(hex: string): Rgb | null {
  const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;
  if (cleaned.length !== 6) return null;
  const num = Number.parseInt(cleaned, 16);
  if (Number.isNaN(num)) return null;
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rN) h = (gN - bN) / d + (gN < bN ? 6 : 0);
  else if (max === gN) h = (bN - rN) / d + 2;
  else h = (rN - gN) / d + 4;
  h *= 60;
  return [h, s * 100, l * 100];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hN = h / 60;
  const x = c * (1 - Math.abs((hN % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hN >= 0 && hN < 1) [r, g, b] = [c, x, 0];
  else if (hN < 2) [r, g, b] = [x, c, 0];
  else if (hN < 3) [r, g, b] = [0, c, x];
  else if (hN < 4) [r, g, b] = [0, x, c];
  else if (hN < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lN - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToHsl(hex: string): Hsl | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return rgbToHsl(rgb[0], rgb[1], rgb[2]);
}

function hslToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

/** Derive a body background that carries the author's accent hue but stays
 * legible against `theme.text` and `theme.muted`. Dark themes get a deep,
 * lightly-tinted backdrop; light themes get a near-white tint. Returns null
 * for unparseable hex so callers can fall back to `theme.noteBackground`. */
export function deriveAuthorBackground(
  accent: string,
  appearance: "light" | "dark",
): string | null {
  const hsl = hexToHsl(accent);
  if (!hsl) return null;
  const [h, s] = hsl;
  if (appearance === "dark") {
    return hslToHex(h, Math.min(s, 32), 15);
  }
  return hslToHex(h, Math.min(s, 90), 95);
}

/** Derive the title-strip background. Slightly more saturated and one shade
 * away from the body backdrop so the title row reads as its own band. */
export function deriveAuthorTitleBackground(
  accent: string,
  appearance: "light" | "dark",
): string | null {
  const hsl = hexToHsl(accent);
  if (!hsl) return null;
  const [h, s] = hsl;
  if (appearance === "dark") {
    return hslToHex(h, Math.min(s, 40), 22);
  }
  return hslToHex(h, Math.min(s, 95), 91);
}
