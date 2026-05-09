import { RGBA, SyntaxStyle, type ThemeMode } from "@opentui/core";
import type { CustomThemeConfig } from "../core/types";
import { blendHex } from "./lib/color";

export interface AppTheme {
  id: string;
  label: string;
  appearance: "light" | "dark";
  background: string;
  panel: string;
  panelAlt: string;
  border: string;
  accent: string;
  accentMuted: string;
  text: string;
  muted: string;
  addedBg: string;
  removedBg: string;
  contextBg: string;
  addedContentBg: string;
  removedContentBg: string;
  contextContentBg: string;
  addedSignColor: string;
  removedSignColor: string;
  lineNumberBg: string;
  lineNumberFg: string;
  selectedHunk: string;
  badgeAdded: string;
  badgeRemoved: string;
  badgeNeutral: string;
  fileNew: string;
  fileDeleted: string;
  fileRenamed: string;
  fileModified: string;
  fileUntracked: string;
  noteBorder: string;
  noteBackground: string;
  noteTitleBackground: string;
  noteTitleText: string;
  syntaxColors: SyntaxColors;
  syntaxStyle: SyntaxStyle;
}

type SyntaxColors = {
  default: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
  function: string;
  property: string;
  type: string;
  punctuation: string;
};

type ThemeBase = Omit<AppTheme, "syntaxColors" | "syntaxStyle">;

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

/** Build the syntax palette OpenTUI should use for in-terminal code rendering. */
function createSyntaxStyle(colors: SyntaxColors) {
  return SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(colors.default) },
    keyword: { fg: RGBA.fromHex(colors.keyword), bold: true },
    string: { fg: RGBA.fromHex(colors.string) },
    comment: { fg: RGBA.fromHex(colors.comment), italic: true },
    number: { fg: RGBA.fromHex(colors.number) },
    function: { fg: RGBA.fromHex(colors.function) },
    method: { fg: RGBA.fromHex(colors.function) },
    property: { fg: RGBA.fromHex(colors.property) },
    variable: { fg: RGBA.fromHex(colors.default) },
    constant: { fg: RGBA.fromHex(colors.number), bold: true },
    type: { fg: RGBA.fromHex(colors.type) },
    class: { fg: RGBA.fromHex(colors.type) },
    punctuation: { fg: RGBA.fromHex(colors.punctuation) },
  });
}

/** Lazily attach syntax colors so startup only pays for the active theme's token style. */
function withLazySyntaxStyle(theme: ThemeBase, syntaxColors: SyntaxColors): AppTheme {
  let syntaxStyle: SyntaxStyle | null = null;

  return {
    ...theme,
    syntaxColors,
    get syntaxStyle() {
      syntaxStyle ??= createSyntaxStyle(syntaxColors);
      return syntaxStyle;
    },
  };
}

/** Return the built-in theme by id so config-defined themes can inherit from it. */
function builtInThemeById(themeId: string | undefined) {
  return THEMES.find((theme) => theme.id === themeId);
}

/** Return the explicit built-in fallback theme used across startup and missing ids. */
function fallbackTheme() {
  return builtInThemeById("graphite") ?? THEMES[0]!;
}

/** Build one config-defined custom theme by inheriting from a built-in base palette. */
function buildCustomTheme(customTheme: CustomThemeConfig) {
  const baseTheme = builtInThemeById(customTheme.base) ?? fallbackTheme();
  const themeBase: ThemeBase = {
    ...baseTheme,
    id: "custom",
    label: customTheme.label ?? "Custom",
    background: customTheme.background ?? baseTheme.background,
    panel: customTheme.panel ?? baseTheme.panel,
    panelAlt: customTheme.panelAlt ?? baseTheme.panelAlt,
    border: customTheme.border ?? baseTheme.border,
    accent: customTheme.accent ?? baseTheme.accent,
    accentMuted: customTheme.accentMuted ?? baseTheme.accentMuted,
    text: customTheme.text ?? baseTheme.text,
    muted: customTheme.muted ?? baseTheme.muted,
    addedBg: customTheme.addedBg ?? baseTheme.addedBg,
    removedBg: customTheme.removedBg ?? baseTheme.removedBg,
    contextBg: customTheme.contextBg ?? baseTheme.contextBg,
    addedContentBg: customTheme.addedContentBg ?? baseTheme.addedContentBg,
    removedContentBg: customTheme.removedContentBg ?? baseTheme.removedContentBg,
    contextContentBg: customTheme.contextContentBg ?? baseTheme.contextContentBg,
    addedSignColor: customTheme.addedSignColor ?? baseTheme.addedSignColor,
    removedSignColor: customTheme.removedSignColor ?? baseTheme.removedSignColor,
    lineNumberBg: customTheme.lineNumberBg ?? baseTheme.lineNumberBg,
    lineNumberFg: customTheme.lineNumberFg ?? baseTheme.lineNumberFg,
    selectedHunk: customTheme.selectedHunk ?? baseTheme.selectedHunk,
    badgeAdded: customTheme.badgeAdded ?? baseTheme.badgeAdded,
    badgeRemoved: customTheme.badgeRemoved ?? baseTheme.badgeRemoved,
    badgeNeutral: customTheme.badgeNeutral ?? baseTheme.badgeNeutral,
    fileNew: customTheme.fileNew ?? baseTheme.fileNew,
    fileDeleted: customTheme.fileDeleted ?? baseTheme.fileDeleted,
    fileRenamed: customTheme.fileRenamed ?? baseTheme.fileRenamed,
    fileModified: customTheme.fileModified ?? baseTheme.fileModified,
    fileUntracked: customTheme.fileUntracked ?? baseTheme.fileUntracked,
    noteBorder: customTheme.noteBorder ?? baseTheme.noteBorder,
    noteBackground: customTheme.noteBackground ?? baseTheme.noteBackground,
    noteTitleBackground: customTheme.noteTitleBackground ?? baseTheme.noteTitleBackground,
    noteTitleText: customTheme.noteTitleText ?? baseTheme.noteTitleText,
  };

  return withLazySyntaxStyle(themeBase, {
    ...baseTheme.syntaxColors,
    ...customTheme.syntax,
  });
}

/** Return the theme ids the app should expose based on whether config defines a custom palette. */
export function availableThemeIds(customTheme?: CustomThemeConfig): string[] {
  const themeIds = THEMES.map((theme) => theme.id);
  if (customTheme) {
    themeIds.push("custom");
  }
  return themeIds;
}

/** Return the menu/cycle themes, adding the config-defined custom theme only when available. */
export function availableThemes(customTheme?: CustomThemeConfig): AppTheme[] {
  return customTheme ? [...THEMES, buildCustomTheme(customTheme)] : THEMES;
}

/** Map official Catppuccin palette tokens into Hunk's semantic theme slots. */
function createCatppuccinTheme(flavor: CatppuccinFlavor) {
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

export const THEMES: AppTheme[] = [
  withLazySyntaxStyle(
    {
      id: "graphite",
      label: "Graphite",
      appearance: "dark",
      background: "#111315",
      panel: "#171a1d",
      panelAlt: "#1d2126",
      border: "#343c45",
      accent: "#d5e0ea",
      accentMuted: "#414a54",
      text: "#f2f4f6",
      muted: "#9aa4af",
      addedBg: "#1f3025",
      removedBg: "#372526",
      contextBg: "#181c20",
      addedContentBg: "#24362a",
      removedContentBg: "#432b2d",
      contextContentBg: "#1e2328",
      addedSignColor: "#88d39b",
      removedSignColor: "#f0a0a0",
      lineNumberBg: "#14181b",
      lineNumberFg: "#798592",
      selectedHunk: "#4f5d6b",
      badgeAdded: "#88d39b",
      badgeRemoved: "#f0a0a0",
      badgeNeutral: "#a9b4bf",
      fileNew: "#88d39b",
      fileDeleted: "#f0a0a0",
      fileRenamed: "#e6cf98",
      fileModified: "#c49bff",
      fileUntracked: "#7fd1ff",
      noteBorder: "#c6a0ff",
      noteBackground: "#241c31",
      noteTitleBackground: "#322446",
      noteTitleText: "#f5edff",
    },
    {
      default: "#f2f4f6",
      keyword: "#c4d0da",
      string: "#d8c6ef",
      comment: "#7f8b97",
      number: "#e6cf98",
      function: "#dfe6ed",
      property: "#bac8d4",
      type: "#d3d9e2",
      punctuation: "#7f8b97",
    },
  ),
  withLazySyntaxStyle(
    {
      id: "midnight",
      label: "Midnight",
      appearance: "dark",
      background: "#08111f",
      panel: "#0e1b2e",
      panelAlt: "#13243a",
      border: "#284264",
      accent: "#7fd1ff",
      accentMuted: "#355578",
      text: "#eef4ff",
      muted: "#8da5c7",
      addedBg: "#153526",
      removedBg: "#47262a",
      contextBg: "#0f1b2d",
      addedContentBg: "#102a1f",
      removedContentBg: "#371b1e",
      contextContentBg: "#132238",
      addedSignColor: "#69d69a",
      removedSignColor: "#ff8e8e",
      lineNumberBg: "#0b1627",
      lineNumberFg: "#56739a",
      selectedHunk: "#2a6a8a",
      badgeAdded: "#5ad188",
      badgeRemoved: "#ff8b8b",
      badgeNeutral: "#89a5d3",
      fileNew: "#5ad188",
      fileDeleted: "#ff8b8b",
      fileRenamed: "#ffd883",
      fileModified: "#b794f6",
      fileUntracked: "#7fd1ff",
      noteBorder: "#c49bff",
      noteBackground: "#211a36",
      noteTitleBackground: "#30234f",
      noteTitleText: "#f5eeff",
    },
    {
      default: "#e8f1ff",
      keyword: "#8ed4ff",
      string: "#c7b4ff",
      comment: "#6e85a7",
      number: "#ffd883",
      function: "#b6c9ff",
      property: "#a8d6ff",
      type: "#a4b7ff",
      punctuation: "#6e85a7",
    },
  ),
  withLazySyntaxStyle(
    {
      id: "paper",
      label: "Paper",
      appearance: "light",
      background: "#f4efe6",
      panel: "#fffaf3",
      panelAlt: "#f8f1e7",
      border: "#d8c8b3",
      accent: "#77593a",
      accentMuted: "#d7ccbe",
      text: "#2f2417",
      muted: "#786753",
      addedBg: "#dff0e1",
      removedBg: "#f6ddde",
      contextBg: "#faf6ee",
      addedContentBg: "#eaf8ec",
      removedContentBg: "#fbebeb",
      contextContentBg: "#fffaf3",
      addedSignColor: "#3f8d58",
      removedSignColor: "#b4545b",
      lineNumberBg: "#f2e9dc",
      lineNumberFg: "#9b8367",
      selectedHunk: "#d2c0a5",
      badgeAdded: "#3f8d58",
      badgeRemoved: "#b4545b",
      badgeNeutral: "#8e7355",
      fileNew: "#3f8d58",
      fileDeleted: "#b4545b",
      fileRenamed: "#9f6c1f",
      fileModified: "#7d5bc4",
      fileUntracked: "#4a6890",
      noteBorder: "#7d5bc4",
      noteBackground: "#efe6ff",
      noteTitleBackground: "#e3d7ff",
      noteTitleText: "#462b74",
    },
    {
      default: "#2f2417",
      keyword: "#7b5a35",
      string: "#4a6890",
      comment: "#8f7a65",
      number: "#9f6c1f",
      function: "#5a4a8e",
      property: "#356b7f",
      type: "#5f5f9a",
      punctuation: "#8f7a65",
    },
  ),
  withLazySyntaxStyle(
    {
      id: "ember",
      label: "Ember",
      appearance: "dark",
      background: "#140b08",
      panel: "#22120d",
      panelAlt: "#2c1710",
      border: "#643627",
      accent: "#ffb07a",
      accentMuted: "#5d3428",
      text: "#fff0e6",
      muted: "#c7a18d",
      addedBg: "#183424",
      removedBg: "#4a1f1f",
      contextBg: "#24140e",
      addedContentBg: "#21432c",
      removedContentBg: "#5a2727",
      contextContentBg: "#2b1711",
      addedSignColor: "#83d99d",
      removedSignColor: "#ff9d8f",
      lineNumberBg: "#1c100c",
      lineNumberFg: "#9a735f",
      selectedHunk: "#8a4d3a",
      badgeAdded: "#83d99d",
      badgeRemoved: "#ff9d8f",
      badgeNeutral: "#f1be9d",
      fileNew: "#83d99d",
      fileDeleted: "#ff9d8f",
      fileRenamed: "#ffd08f",
      fileModified: "#d8b4fe",
      fileUntracked: "#ffb07a",
      noteBorder: "#e1a3ff",
      noteBackground: "#311d36",
      noteTitleBackground: "#452650",
      noteTitleText: "#fff0ff",
    },
    {
      default: "#fff0e6",
      keyword: "#ffb47f",
      string: "#ffd3a8",
      comment: "#a17d69",
      number: "#ffd08f",
      function: "#ffd9b3",
      property: "#ffc89f",
      type: "#f7c5b0",
      punctuation: "#a17d69",
    },
  ),
  createCatppuccinTheme("latte"),
  createCatppuccinTheme("mocha"),
];

/** Resolve a named theme, including explicit terminal-background auto mode and custom themes, or fall back to Hunk's explicit built-in default. */
export function resolveTheme(
  requested: string | undefined,
  themeMode: ThemeMode | null,
  customTheme?: CustomThemeConfig,
) {
  if (requested === "auto") {
    const preferred = themeMode === "light" ? "paper" : "graphite";
    return THEMES.find((theme) => theme.id === preferred) ?? THEMES[0]!;
  } else if (requested === "custom" && customTheme) {
    return buildCustomTheme(customTheme);
  }

  const exact = THEMES.find((theme) => theme.id === requested);
  if (exact) {
    return exact;
  }

  return fallbackTheme();
}
