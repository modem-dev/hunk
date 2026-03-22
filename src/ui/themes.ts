import { RGBA, SyntaxStyle, type ThemeMode } from "@opentui/core";

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
function withLazySyntaxStyle(theme: Omit<AppTheme, "syntaxColors" | "syntaxStyle">, syntaxColors: SyntaxColors): AppTheme {
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

export const THEMES: AppTheme[] = [
  withLazySyntaxStyle({
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
    selectedHunk: "#3b434b",
    badgeAdded: "#88d39b",
    badgeRemoved: "#f0a0a0",
    badgeNeutral: "#a9b4bf",
  }, {
      default: "#f2f4f6",
      keyword: "#c4d0da",
      string: "#d8c6ef",
      comment: "#7f8b97",
      number: "#e6cf98",
      function: "#dfe6ed",
      property: "#bac8d4",
      type: "#d3d9e2",
      punctuation: "#7f8b97",
    }),
  withLazySyntaxStyle({
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
    selectedHunk: "#20466a",
    badgeAdded: "#5ad188",
    badgeRemoved: "#ff8b8b",
    badgeNeutral: "#89a5d3",
  }, {
      default: "#e8f1ff",
      keyword: "#8ed4ff",
      string: "#c7b4ff",
      comment: "#6e85a7",
      number: "#ffd883",
      function: "#b6c9ff",
      property: "#a8d6ff",
      type: "#a4b7ff",
      punctuation: "#6e85a7",
    }),
  withLazySyntaxStyle({
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
    selectedHunk: "#eadcc5",
    badgeAdded: "#3f8d58",
    badgeRemoved: "#b4545b",
    badgeNeutral: "#8e7355",
  }, {
      default: "#2f2417",
      keyword: "#7b5a35",
      string: "#4a6890",
      comment: "#8f7a65",
      number: "#9f6c1f",
      function: "#5a4a8e",
      property: "#356b7f",
      type: "#5f5f9a",
      punctuation: "#8f7a65",
    }),
  withLazySyntaxStyle({
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
    selectedHunk: "#6a3829",
    badgeAdded: "#83d99d",
    badgeRemoved: "#ff9d8f",
    badgeNeutral: "#f1be9d",
  }, {
      default: "#fff0e6",
      keyword: "#ffb47f",
      string: "#ffd3a8",
      comment: "#a17d69",
      number: "#ffd08f",
      function: "#ffd9b3",
      property: "#ffc89f",
      type: "#f7c5b0",
      punctuation: "#a17d69",
    }),
];

/** Resolve a named theme or fall back to a theme that matches the renderer mode. */
export function resolveTheme(requested: string | undefined, themeMode: ThemeMode | null) {
  const exact = THEMES.find((theme) => theme.id === requested);
  if (exact) {
    return exact;
  }

  if (themeMode === "light") {
    return THEMES.find((theme) => theme.id === "paper") ?? THEMES[0]!;
  }

  return THEMES.find((theme) => theme.id === "graphite") ?? THEMES[0]!;
}
