export const BUNDLED_SHIKI_THEME_IDS = [
  "andromeeda",
  "aurora-x",
  "ayu-dark",
  "ayu-light",
  "ayu-mirage",
  "catppuccin-frappe",
  "catppuccin-latte",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "dark-plus",
  "dracula",
  "dracula-soft",
  "everforest-dark",
  "everforest-light",
  "github-dark",
  "github-dark-default",
  "github-dark-dimmed",
  "github-dark-high-contrast",
  "github-light",
  "github-light-default",
  "github-light-high-contrast",
  "gruvbox-dark-hard",
  "gruvbox-dark-medium",
  "gruvbox-dark-soft",
  "gruvbox-light-hard",
  "gruvbox-light-medium",
  "gruvbox-light-soft",
  "horizon",
  "horizon-bright",
  "houston",
  "kanagawa-dragon",
  "kanagawa-lotus",
  "kanagawa-wave",
  "laserwave",
  "light-plus",
  "material-theme",
  "material-theme-darker",
  "material-theme-lighter",
  "material-theme-ocean",
  "material-theme-palenight",
  "min-dark",
  "min-light",
  "monokai",
  "night-owl",
  "night-owl-light",
  "nord",
  "one-dark-pro",
  "one-light",
  "plastic",
  "poimandres",
  "red",
  "rose-pine",
  "rose-pine-dawn",
  "rose-pine-moon",
  "slack-dark",
  "slack-ochin",
  "snazzy-light",
  "solarized-dark",
  "solarized-light",
  "synthwave-84",
  "tokyo-night",
  "vesper",
  "vitesse-black",
  "vitesse-dark",
  "vitesse-light",
] as const;

export type BundledShikiThemeId = (typeof BUNDLED_SHIKI_THEME_IDS)[number];

export const LEGACY_THEME_ID_ALIASES = {
  graphite: "github-dark-default",
  midnight: "github-dark-dimmed",
  paper: "github-light-default",
  ember: "dark-plus",
  zenburn: "everforest-dark",
} as const satisfies Record<string, BundledShikiThemeId>;

/** Map removed pre-refactor theme ids to their closest built-in replacements. */
export function resolveLegacyThemeId(themeId: string | undefined) {
  return themeId
    ? (LEGACY_THEME_ID_ALIASES[themeId as keyof typeof LEGACY_THEME_ID_ALIASES] ?? themeId)
    : undefined;
}

/** Resolve a current or legacy id when it names one bundled theme. */
export function resolveBundledShikiThemeId(
  themeId: string | undefined,
): BundledShikiThemeId | undefined {
  const resolvedThemeId = resolveLegacyThemeId(themeId);
  return BUNDLED_SHIKI_THEME_IDS.includes(resolvedThemeId as BundledShikiThemeId)
    ? (resolvedThemeId as BundledShikiThemeId)
    : undefined;
}

export interface BundledShikiThemeDiffColors {
  added?: string;
  removed?: string;
  modified?: string;
}

export const BUNDLED_SHIKI_THEME_BACKGROUNDS: Record<BundledShikiThemeId, string> = {
  andromeeda: "#23262e",
  "aurora-x": "#07090f",
  "ayu-dark": "#10141c",
  "ayu-light": "#fcfcfc",
  "ayu-mirage": "#242936",
  "catppuccin-frappe": "#303446",
  "catppuccin-latte": "#eff1f5",
  "catppuccin-macchiato": "#24273a",
  "catppuccin-mocha": "#1e1e2e",
  "dark-plus": "#1e1e1e",
  dracula: "#282a36",
  "dracula-soft": "#282a36",
  "everforest-dark": "#2d353b",
  "everforest-light": "#fdf6e3",
  "github-dark": "#24292e",
  "github-dark-default": "#0d1117",
  "github-dark-dimmed": "#22272e",
  "github-dark-high-contrast": "#0a0c10",
  "github-light": "#ffffff",
  "github-light-default": "#ffffff",
  "github-light-high-contrast": "#ffffff",
  "gruvbox-dark-hard": "#1d2021",
  "gruvbox-dark-medium": "#282828",
  "gruvbox-dark-soft": "#32302f",
  "gruvbox-light-hard": "#f9f5d7",
  "gruvbox-light-medium": "#fbf1c7",
  "gruvbox-light-soft": "#f2e5bc",
  horizon: "#1c1e26",
  "horizon-bright": "#fdf0ed",
  houston: "#17191e",
  "kanagawa-dragon": "#181616",
  "kanagawa-lotus": "#f2ecbc",
  "kanagawa-wave": "#1f1f28",
  laserwave: "#27212e",
  "light-plus": "#ffffff",
  "material-theme": "#263238",
  "material-theme-darker": "#212121",
  "material-theme-lighter": "#fafafa",
  "material-theme-ocean": "#0f111a",
  "material-theme-palenight": "#292d3e",
  "min-dark": "#1f1f1f",
  "min-light": "#ffffff",
  monokai: "#272822",
  "night-owl": "#011627",
  "night-owl-light": "#fbfbfb",
  nord: "#2e3440",
  "one-dark-pro": "#282c34",
  "one-light": "#fafafa",
  plastic: "#21252b",
  poimandres: "#1b1e28",
  red: "#390000",
  "rose-pine": "#191724",
  "rose-pine-dawn": "#faf4ed",
  "rose-pine-moon": "#232136",
  "slack-dark": "#222222",
  "slack-ochin": "#ffffff",
  "snazzy-light": "#fafbfc",
  "solarized-dark": "#002b36",
  "solarized-light": "#fdf6e3",
  "synthwave-84": "#262335",
  "tokyo-night": "#1a1b26",
  vesper: "#101010",
  "vitesse-black": "#000000",
  "vitesse-dark": "#121212",
  "vitesse-light": "#ffffff",
};

export const BUNDLED_SHIKI_THEME_FOREGROUNDS: Partial<Record<BundledShikiThemeId, string>> = {
  andromeeda: "#d5ced9",
  "ayu-dark": "#bfbdb6",
  "ayu-light": "#5c6166",
  "ayu-mirage": "#cccac2",
  "catppuccin-frappe": "#c6d0f5",
  "catppuccin-latte": "#4c4f69",
  "catppuccin-macchiato": "#cad3f5",
  "catppuccin-mocha": "#cdd6f4",
  "dark-plus": "#d4d4d4",
  dracula: "#f8f8f2",
  "dracula-soft": "#f6f6f4",
  "everforest-dark": "#d3c6aa",
  "everforest-light": "#5c6a72",
  "github-dark": "#e1e4e8",
  "github-dark-default": "#e6edf3",
  "github-dark-dimmed": "#adbac7",
  "github-dark-high-contrast": "#f0f3f6",
  "github-light": "#24292e",
  "github-light-default": "#1f2328",
  "github-light-high-contrast": "#0e1116",
  "gruvbox-dark-hard": "#ebdbb2",
  "gruvbox-dark-medium": "#ebdbb2",
  "gruvbox-dark-soft": "#ebdbb2",
  "gruvbox-light-hard": "#3c3836",
  "gruvbox-light-medium": "#3c3836",
  "gruvbox-light-soft": "#3c3836",
  houston: "#eef0f9",
  "kanagawa-dragon": "#c5c9c5",
  "kanagawa-lotus": "#545464",
  "kanagawa-wave": "#dcd7ba",
  laserwave: "#ffffff",
  "light-plus": "#000000",
  "material-theme": "#eeffff",
  "material-theme-darker": "#eeffff",
  "material-theme-lighter": "#90a4ae",
  "material-theme-ocean": "#babed8",
  "material-theme-palenight": "#babed8",
  "min-light": "#212121",
  monokai: "#f8f8f2",
  "night-owl": "#d6deeb",
  "night-owl-light": "#403f53",
  nord: "#d8dee9",
  "one-dark-pro": "#abb2bf",
  "one-light": "#383a42",
  plastic: "#a9b2c3",
  poimandres: "#a6accd",
  red: "#f8f8f8",
  "rose-pine": "#e0def4",
  "rose-pine-dawn": "#575279",
  "rose-pine-moon": "#e0def4",
  "slack-dark": "#e6e6e6",
  "slack-ochin": "#000000",
  "snazzy-light": "#565869",
  "solarized-dark": "#839496",
  "solarized-light": "#657b83",
  "tokyo-night": "#a9b1d6",
  vesper: "#ffffff",
  "vitesse-black": "#dbd7ca",
  "vitesse-dark": "#dbd7ca",
  "vitesse-light": "#393a34",
};

// Run `bun run generate:theme-colors` to regenerate; don't edit by hand.
// GENERATED:BUNDLED_SHIKI_THEME_DIFF_COLORS:START
export const BUNDLED_SHIKI_THEME_DIFF_COLORS: Partial<
  Record<BundledShikiThemeId, BundledShikiThemeDiffColors>
> = {
  andromeeda: { added: "#9bc53d", removed: "#fc644d", modified: "#5bc0eb" },
  "aurora-x": { added: "#64d389", removed: "#dd5074", modified: "#c778db" },
  "ayu-dark": { added: "#70bf56", removed: "#f26d78", modified: "#73b8ff" },
  "ayu-light": { added: "#6cbf43", removed: "#ff7383", modified: "#478acc" },
  "ayu-mirage": { added: "#87d96c", removed: "#f27983", modified: "#80bfff" },
  "catppuccin-frappe": { added: "#a6d189", removed: "#e78284", modified: "#e5c890" },
  "catppuccin-latte": { added: "#40a02b", removed: "#d20f39", modified: "#df8e1d" },
  "catppuccin-macchiato": { added: "#a6da95", removed: "#ed8796", modified: "#eed49f" },
  "catppuccin-mocha": { added: "#a6e3a1", removed: "#f38ba8", modified: "#f9e2af" },
  dracula: { added: "#50fa7b", removed: "#ff5555", modified: "#8be9fd" },
  "dracula-soft": { added: "#50fa7b", removed: "#ff5555", modified: "#8be9fd" },
  "everforest-dark": { added: "#899c40", removed: "#da6362", modified: "#5a93a2" },
  "everforest-light": { added: "#8da101", removed: "#f1706f", modified: "#3a94c5" },
  "github-dark": { added: "#28a745", removed: "#ea4a5a", modified: "#2188ff" },
  "github-dark-default": { added: "#2ea043", removed: "#f85149", modified: "#bb8009" },
  "github-dark-dimmed": { added: "#46954a", removed: "#e5534b", modified: "#ae7c14" },
  "github-dark-high-contrast": { added: "#09b43a", removed: "#ff6a69", modified: "#e09b13" },
  "github-light": { added: "#28a745", removed: "#d73a49", modified: "#2188ff" },
  "github-light-default": { added: "#116329", removed: "#cf222e", modified: "#9a6700" },
  "github-light-high-contrast": { added: "#26a148", removed: "#ee5a5d", modified: "#b58407" },
  "gruvbox-dark-hard": { added: "#b8bb26", removed: "#fb4934", modified: "#83a598" },
  "gruvbox-dark-medium": { added: "#b8bb26", removed: "#fb4934", modified: "#83a598" },
  "gruvbox-dark-soft": { added: "#b8bb26", removed: "#fb4934", modified: "#83a598" },
  "gruvbox-light-hard": { added: "#79740e", removed: "#9d0006", modified: "#076678" },
  "gruvbox-light-medium": { added: "#79740e", removed: "#9d0006", modified: "#076678" },
  "gruvbox-light-soft": { added: "#79740e", removed: "#9d0006", modified: "#076678" },
  horizon: { added: "#09f7a0", removed: "#f43e5c", modified: "#21bfc2" },
  "horizon-bright": { added: "#29d398", removed: "#f43e5c", modified: "#af5427" },
  houston: { added: "#4bf3c8", removed: "#f06788", modified: "#54b9ff" },
  "kanagawa-dragon": { added: "#76946a", removed: "#c34043", modified: "#dca561" },
  "kanagawa-lotus": { added: "#6e915f", removed: "#d7474b", modified: "#4d699b" },
  "kanagawa-wave": { added: "#76946a", removed: "#c34043", modified: "#dca561" },
  laserwave: { added: "#74dfc4", removed: "#eb64b9", modified: "#40b4c4" },
  "material-theme": { added: "#c3e88d", removed: "#f07178", modified: "#82aaff" },
  "material-theme-darker": { added: "#c3e88d", removed: "#f07178", modified: "#82aaff" },
  "material-theme-lighter": { added: "#39adb5", removed: "#e53935", modified: "#6182b8" },
  "material-theme-ocean": { added: "#c3e88d", removed: "#f07178", modified: "#82aaff" },
  "material-theme-palenight": { added: "#c3e88d", removed: "#f07178", modified: "#82aaff" },
  "min-light": { added: "#77cc00", removed: "#d32f2f" },
  monokai: { added: "#86b42b", removed: "#c4265e", modified: "#6a7ec8" },
  "night-owl": { added: "#9ccc65", removed: "#ef5350", modified: "#e2b93d" },
  "night-owl-light": { added: "#08916a", removed: "#f76e6e", modified: "#288ed7" },
  nord: { added: "#a3be8c", removed: "#bf616a", modified: "#ebcb8b" },
  "one-dark-pro": { added: "#109868", removed: "#e05561", modified: "#948b60" },
  "one-light": { added: "#00809b" },
  plastic: { added: "#98c379", removed: "#e06c75", modified: "#d19a66" },
  poimandres: { added: "#5fb3a1", removed: "#d0679d", modified: "#add7ff" },
  "rose-pine": { added: "#9ccfd8", removed: "#eb6f92", modified: "#ebbcba" },
  "rose-pine-dawn": { added: "#56949f", removed: "#b4637a", modified: "#d7827e" },
  "rose-pine-moon": { added: "#9ccfd8", removed: "#eb6f92", modified: "#ea9a97" },
  "slack-ochin": { added: "#91b859", removed: "#e53935", modified: "#ecb22e" },
  "snazzy-light": { added: "#2dae58", removed: "#ff5c57", modified: "#00a39f" },
  "solarized-dark": { added: "#859900", removed: "#dc322f", modified: "#268bd2" },
  "solarized-light": { added: "#859900", removed: "#dc322f", modified: "#268bd2" },
  "synthwave-84": { added: "#0beb99", removed: "#fa2e46", modified: "#b893ce" },
  "tokyo-night": { added: "#41a6b5", removed: "#db4b4b", modified: "#6183bb" },
  vesper: { added: "#99ffe4", removed: "#ff8080", modified: "#ffc799" },
  "vitesse-black": { added: "#4d9375", removed: "#cb7676", modified: "#6394bf" },
  "vitesse-dark": { added: "#4d9375", removed: "#cb7676", modified: "#6394bf" },
  "vitesse-light": { added: "#1e754f", removed: "#ab5959", modified: "#296aa3" },
};
// GENERATED:BUNDLED_SHIKI_THEME_DIFF_COLORS:END

/** Return the editor surface declared by a bundled Shiki theme, when Hunk knows it. */
export function getBundledShikiThemeBackground(themeId: string | undefined) {
  return themeId && themeId in BUNDLED_SHIKI_THEME_BACKGROUNDS
    ? BUNDLED_SHIKI_THEME_BACKGROUNDS[themeId as BundledShikiThemeId]
    : undefined;
}

/** Return the editor foreground declared by a bundled Shiki theme, when Hunk knows it. */
export function getBundledShikiThemeForeground(themeId: string | undefined) {
  return themeId && themeId in BUNDLED_SHIKI_THEME_FOREGROUNDS
    ? BUNDLED_SHIKI_THEME_FOREGROUNDS[themeId as BundledShikiThemeId]
    : undefined;
}

/** Return semantic diff colors declared by a bundled Shiki theme, when Hunk knows them. */
export function getBundledShikiThemeDiffColors(themeId: string | undefined) {
  return themeId && themeId in BUNDLED_SHIKI_THEME_DIFF_COLORS
    ? BUNDLED_SHIKI_THEME_DIFF_COLORS[themeId as BundledShikiThemeId]
    : undefined;
}
