/** Lists the source logos and generated download variants used by the brand page. */
export const brandLogos = [
  {
    id: "logo-mark",
    name: "Flat mark",
    description: "The everyday mark. Use for icons, avatars, and small placements.",
    width: 116,
    height: 115,
  },
  {
    id: "logo-mark-3d",
    name: "3D mark",
    description: "The block with its offset outline. Use at 40px and up.",
    width: 95,
    height: 94,
  },
  {
    id: "logo-wordmark",
    name: "Wordmark",
    description: "Just the lowercase letters, drawn as paths. No font needed.",
    width: 125,
    height: 51,
  },
  {
    id: "logo-lockup",
    name: "Full lockup",
    description: "Mark and wordmark together. For slides, articles, and larger placements.",
    width: 224,
    height: 94,
  },
] as const;

export const brandColors = [
  { id: "ink", name: "Ink", value: "#16140f", background: "#f4f1ea" },
  { id: "paper", name: "Paper", value: "#fffdf8", background: "#16140f" },
] as const;

// Transparent PNGs vanish in viewers whose backdrop matches the logo color, so each color also
// ships a solid PNG filled with its paired background.
export const brandFormats = [
  { id: "svg", label: "SVG", name: "SVG", extension: "svg" },
  { id: "png", label: "PNG", name: "transparent PNG", extension: "png" },
  { id: "solid-png", label: "Solid PNG", name: "solid PNG", extension: "png" },
  { id: "pdf", label: "PDF", name: "PDF", extension: "pdf" },
] as const;

export type BrandFormatId = (typeof brandFormats)[number]["id"];

/** Resolves an original ink SVG or a generated color/format variant. */
export function brandDownloadPath(id: string, color: string, format: BrandFormatId): string {
  if (color === "ink" && format === "svg") return `/brand/${id}.svg`;
  if (format === "solid-png") return `/brand/downloads/${id}-${color}-solid.png`;
  return `/brand/downloads/${id}-${color}.${format}`;
}
