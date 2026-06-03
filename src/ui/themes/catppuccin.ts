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
  frappe: {
    rosewater: "#f2d5cf",
    flamingo: "#eebebe",
    pink: "#f4b8e4",
    mauve: "#ca9ee6",
    red: "#e78284",
    maroon: "#ea999c",
    peach: "#ef9f76",
    yellow: "#e5c890",
    green: "#a6d189",
    teal: "#81c8be",
    sky: "#99d1db",
    sapphire: "#85c1dc",
    blue: "#8caaee",
    lavender: "#babbf1",
    text: "#c6d0f5",
    subtext1: "#b5bfe2",
    subtext0: "#a5adce",
    overlay2: "#949cbb",
    overlay1: "#838ba7",
    overlay0: "#737994",
    surface2: "#626880",
    surface1: "#51576d",
    surface0: "#414559",
    base: "#303446",
    mantle: "#292c3c",
    crust: "#232634",
  },
  macchiato: {
    rosewater: "#f4dbd6",
    flamingo: "#f0c6c6",
    pink: "#f5bde6",
    mauve: "#c6a0f6",
    red: "#ed8796",
    maroon: "#ee99a0",
    peach: "#f5a97f",
    yellow: "#eed49f",
    green: "#a6da95",
    teal: "#8bd5ca",
    sky: "#91d7e3",
    sapphire: "#7dc4e4",
    blue: "#8aadf4",
    lavender: "#b7bdf8",
    text: "#cad3f5",
    subtext1: "#b8c0e0",
    subtext0: "#a5adcb",
    overlay2: "#939ab7",
    overlay1: "#8087a2",
    overlay0: "#6e738d",
    surface2: "#5b6078",
    surface1: "#494d64",
    surface0: "#363a4f",
    base: "#24273a",
    mantle: "#1e2030",
    crust: "#181926",
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
} as const satisfies Record<"latte" | "frappe" | "macchiato" | "mocha", CatppuccinPalette>;

type CatppuccinFlavor = keyof typeof CATPPUCCIN_PALETTES;

const CATPPUCCIN_LABELS: Record<CatppuccinFlavor, string> = {
  latte: "Catppuccin Latte",
  frappe: "Catppuccin Frappé",
  macchiato: "Catppuccin Macchiato",
  mocha: "Catppuccin Mocha",
};

/** Map official Catppuccin palette tokens into Hunk's semantic theme slots. */
export function createCatppuccinTheme(flavor: CatppuccinFlavor) {
  const palette = CATPPUCCIN_PALETTES[flavor];
  const label = CATPPUCCIN_LABELS[flavor];
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

/** Built-in Catppuccin Frappé theme. */
export const CATPPUCCIN_FRAPPE_THEME = createCatppuccinTheme("frappe");

/** Built-in Catppuccin Macchiato theme. */
export const CATPPUCCIN_MACCHIATO_THEME = createCatppuccinTheme("macchiato");

/** Built-in Catppuccin Mocha theme. */
export const CATPPUCCIN_MOCHA_THEME = createCatppuccinTheme("mocha");
