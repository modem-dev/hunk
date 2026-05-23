import { blendHex } from "../lib/color";
import { withLazySyntaxStyle } from "./syntax";
import type { AppTheme } from "./types";

type CatppuccinPalette = {
  rosewater: string;
  flamingo: string;
  pink: string;
  mauve: string;
  red: string;
  maroon: string;
  peach: string;
  yellow: string;
  green: string;
  teal: string;
  sky: string;
  sapphire: string;
  blue: string;
  lavender: string;
  text: string;
  subtext1: string;
  subtext0: string;
  overlay2: string;
  overlay1: string;
  overlay0: string;
  surface2: string;
  surface1: string;
  surface0: string;
  base: string;
  mantle: string;
  crust: string;
};

// Source: https://github.com/catppuccin/palette/blob/main/palette.json
// Cross-check reference: https://catppuccin.com/palette/
// Semantic guidance: https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md
export const CATPPUCCIN_PALETTES = {
  latte: {
    rosewater: "#dc8a78",
    flamingo: "#dd7878",
    pink: "#ea76cb",
    mauve: "#8839ef",
    red: "#d20f39",
    maroon: "#e64553",
    peach: "#fe640b",
    yellow: "#df8e1d",
    green: "#40a02b",
    teal: "#179299",
    sky: "#04a5e5",
    sapphire: "#209fb5",
    blue: "#1e66f5",
    lavender: "#7287fd",
    text: "#4c4f69",
    subtext1: "#5c5f77",
    subtext0: "#6c6f85",
    overlay2: "#7c7f93",
    overlay1: "#8c8fa1",
    overlay0: "#9ca0b0",
    surface2: "#acb0be",
    surface1: "#bcc0cc",
    surface0: "#ccd0da",
    base: "#eff1f5",
    mantle: "#e6e9ef",
    crust: "#dce0e8",
  },
  mocha: {
    rosewater: "#f5e0dc",
    flamingo: "#f2cdcd",
    pink: "#f5c2e7",
    mauve: "#cba6f7",
    red: "#f38ba8",
    maroon: "#eba0ac",
    peach: "#fab387",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    teal: "#94e2d5",
    sky: "#89dceb",
    sapphire: "#74c7ec",
    blue: "#89b4fa",
    lavender: "#b4befe",
    text: "#cdd6f4",
    subtext1: "#bac2de",
    subtext0: "#a6adc8",
    overlay2: "#9399b2",
    overlay1: "#7f849c",
    overlay0: "#6c7086",
    surface2: "#585b70",
    surface1: "#45475a",
    surface0: "#313244",
    base: "#1e1e2e",
    mantle: "#181825",
    crust: "#11111b",
  },
} as const satisfies Record<"latte" | "mocha", CatppuccinPalette>;

type CatppuccinFlavor = keyof typeof CATPPUCCIN_PALETTES;

/** Map official Catppuccin palette tokens into Hunk's semantic theme slots. */
export function createCatppuccinTheme(flavor: CatppuccinFlavor) {
  const palette = CATPPUCCIN_PALETTES[flavor];
  const label = flavor === "latte" ? "Catppuccin Latte" : "Catppuccin Mocha";
  const appearance: AppTheme["appearance"] = flavor === "latte" ? "light" : "dark";
  const panel = flavor === "latte" ? palette.base : palette.mantle;
  const panelAlt = flavor === "latte" ? palette.mantle : palette.base;
  const contextBg = palette.base;

  return withLazySyntaxStyle(
    {
      id: `catppuccin-${flavor}`,
      label,
      appearance,
      background: palette.crust,
      panel,
      panelAlt,
      border: palette.surface1,
      accent: palette.mauve,
      accentMuted: blendHex(palette.mauve, panel, 0.2),
      text: palette.text,
      muted: palette.subtext0,
      addedBg: blendHex(palette.green, contextBg, 0.15),
      removedBg: blendHex(palette.red, contextBg, 0.15),
      contextBg,
      addedContentBg: blendHex(palette.green, contextBg, 0.25),
      removedContentBg: blendHex(palette.red, contextBg, 0.25),
      contextContentBg: contextBg,
      addedSignColor: palette.green,
      removedSignColor: palette.red,
      lineNumberBg: palette.mantle,
      lineNumberFg: palette.overlay1,
      selectedHunk: blendHex(palette.overlay2, contextBg, 0.25),
      badgeAdded: palette.green,
      badgeRemoved: palette.red,
      badgeNeutral: palette.overlay2,
      fileNew: palette.green,
      fileDeleted: palette.red,
      fileRenamed: palette.yellow,
      fileModified: palette.mauve,
      fileUntracked: palette.sky,
      noteBorder: palette.mauve,
      noteBackground: blendHex(palette.mauve, panel, 0.12),
      noteTitleBackground: blendHex(palette.mauve, panel, 0.22),
      noteTitleText: palette.text,
    },
    {
      default: palette.text,
      keyword: palette.mauve,
      string: palette.green,
      comment: palette.overlay2,
      number: palette.peach,
      function: palette.blue,
      property: palette.blue,
      type: palette.yellow,
      punctuation: palette.overlay2,
    },
  );
}

/** Built-in Catppuccin Latte theme. */
export const CATPPUCCIN_LATTE_THEME = createCatppuccinTheme("latte");

/** Built-in Catppuccin Mocha theme. */
export const CATPPUCCIN_MOCHA_THEME = createCatppuccinTheme("mocha");
