import { describe, expect, test } from "bun:test";
import { blendHex, contrastRatio, hexColorDistance } from "./lib/color";
import { BUNDLED_SHIKI_THEME_IDS } from "./lib/shikiThemes";
import {
  CATPPUCCIN_PALETTES,
  resolveTheme,
  TRANSPARENT_BACKGROUND,
  withSyntaxTheme,
  withTransparentBackground,
  withTransparentSurfaces,
} from "./themes";

const MIN_READABLE_TEXT_CONTRAST = 4.5;
const CONTRAST_GATED_THEME_IDS = ["graphite", "midnight", "paper", "ember"] as const;

/** Return a compact failure list for semantic theme foreground/background pairs. */
function themeContrastFailures(
  pairs: Array<{ label: string; foreground: string; background: string; minimum?: number }>,
) {
  return pairs.flatMap(
    ({ label, foreground, background, minimum = MIN_READABLE_TEXT_CONTRAST }) => {
      const ratio = contrastRatio(foreground, background);
      return ratio + 0.005 < minimum
        ? [`${label}: ${ratio.toFixed(2)} (${foreground} on ${background})`]
        : [];
    },
  );
}

describe("themes", () => {
  test("keeps contrast-gated theme diff row text and gutters within thresholds", () => {
    const failures = CONTRAST_GATED_THEME_IDS.flatMap((themeId) => {
      const theme = resolveTheme(themeId, null);
      return themeContrastFailures([
        {
          label: `${theme.id} text/contextBg`,
          foreground: theme.text,
          background: theme.contextBg,
        },
        { label: `${theme.id} text/addedBg`, foreground: theme.text, background: theme.addedBg },
        {
          label: `${theme.id} text/removedBg`,
          foreground: theme.text,
          background: theme.removedBg,
        },
        {
          label: `${theme.id} text/contextContentBg`,
          foreground: theme.text,
          background: theme.contextContentBg,
        },
        {
          label: `${theme.id} text/addedContentBg`,
          foreground: theme.text,
          background: theme.addedContentBg,
        },
        {
          label: `${theme.id} text/removedContentBg`,
          foreground: theme.text,
          background: theme.removedContentBg,
        },
        {
          label: `${theme.id} addedSignColor/addedBg`,
          foreground: theme.addedSignColor,
          background: theme.addedBg,
        },
        {
          label: `${theme.id} removedSignColor/removedBg`,
          foreground: theme.removedSignColor,
          background: theme.removedBg,
        },
        {
          label: `${theme.id} lineNumberFg/lineNumberBg`,
          foreground: theme.lineNumberFg,
          background: theme.lineNumberBg,
        },
      ]);
    });

    expect(failures).toEqual([]);
  });

  test("keeps contrast-gated theme syntax colors within thresholds", () => {
    const syntaxRoles = [
      "default",
      "keyword",
      "string",
      "comment",
      "number",
      "function",
      "property",
      "type",
      "variable",
      "operator",
      "punctuation",
    ] as const;
    const failures = CONTRAST_GATED_THEME_IDS.flatMap((themeId) => {
      const theme = resolveTheme(themeId, null);
      return themeContrastFailures(
        syntaxRoles.flatMap((role) => [
          {
            label: `${theme.id} syntax.${role}/contextBg`,
            foreground: theme.syntaxColors[role] ?? theme.syntaxColors.default,
            background: theme.contextBg,
          },
          {
            label: `${theme.id} syntax.${role}/addedBg`,
            foreground: theme.syntaxColors[role] ?? theme.syntaxColors.default,
            background: theme.addedBg,
          },
          {
            label: `${theme.id} syntax.${role}/removedBg`,
            foreground: theme.syntaxColors[role] ?? theme.syntaxColors.default,
            background: theme.removedBg,
          },
          {
            label: `${theme.id} syntax.${role}/contextContentBg`,
            foreground: theme.syntaxColors[role] ?? theme.syntaxColors.default,
            background: theme.contextContentBg,
          },
          {
            label: `${theme.id} syntax.${role}/addedContentBg`,
            foreground: theme.syntaxColors[role] ?? theme.syntaxColors.default,
            background: theme.addedContentBg,
          },
          {
            label: `${theme.id} syntax.${role}/removedContentBg`,
            foreground: theme.syntaxColors[role] ?? theme.syntaxColors.default,
            background: theme.removedContentBg,
          },
        ]),
      );
    });

    expect(failures).toEqual([]);
  });

  test("keeps contrast-gated theme sidebar and chrome colors within thresholds", () => {
    const failures = CONTRAST_GATED_THEME_IDS.flatMap((themeId) => {
      const theme = resolveTheme(themeId, null);
      const sidebarForegrounds = [
        ["badgeAdded", theme.badgeAdded],
        ["badgeRemoved", theme.badgeRemoved],
        ["badgeNeutral", theme.badgeNeutral],
        ["fileNew", theme.fileNew],
        ["fileDeleted", theme.fileDeleted],
        ["fileRenamed", theme.fileRenamed],
        ["fileModified", theme.fileModified],
        ["fileUntracked", theme.fileUntracked],
      ] as const;
      const sidebarPairs = sidebarForegrounds.flatMap(([field, foreground]) => [
        { label: `${theme.id} ${field}/panel`, foreground, background: theme.panel },
        { label: `${theme.id} ${field}/panelAlt`, foreground, background: theme.panelAlt },
      ]);

      return themeContrastFailures([
        { label: `${theme.id} text/panel`, foreground: theme.text, background: theme.panel },
        { label: `${theme.id} text/panelAlt`, foreground: theme.text, background: theme.panelAlt },
        { label: `${theme.id} muted/panel`, foreground: theme.muted, background: theme.panel },
        {
          label: `${theme.id} muted/panelAlt`,
          foreground: theme.muted,
          background: theme.panelAlt,
        },
        {
          label: `${theme.id} active menu text/accentMuted`,
          foreground: theme.text,
          background: theme.accentMuted,
        },
        ...sidebarPairs,
      ]);
    });

    expect(failures).toEqual([]);
  });

  test("resolves all Catppuccin flavors by theme id", () => {
    const latte = resolveTheme("catppuccin-latte", null);
    const frappe = resolveTheme("catppuccin-frappe", null);
    const macchiato = resolveTheme("catppuccin-macchiato", null);
    const mocha = resolveTheme("catppuccin-mocha", null);

    expect(latte.id).toBe("catppuccin-latte");
    expect(latte.label).toBe("Catppuccin Latte");
    expect(latte.appearance).toBe("light");
    expect(frappe.id).toBe("catppuccin-frappe");
    expect(frappe.label).toBe("Catppuccin Frappé");
    expect(frappe.appearance).toBe("dark");
    expect(macchiato.id).toBe("catppuccin-macchiato");
    expect(macchiato.label).toBe("Catppuccin Macchiato");
    expect(macchiato.appearance).toBe("dark");
    expect(mocha.id).toBe("catppuccin-mocha");
    expect(mocha.label).toBe("Catppuccin Mocha");
    expect(mocha.appearance).toBe("dark");
  });

  test("keeps official Catppuccin sentinel colors in source", () => {
    expect(CATPPUCCIN_PALETTES.latte.base).toBe("#eff1f5");
    expect(CATPPUCCIN_PALETTES.latte.mauve).toBe("#8839ef");
    expect(CATPPUCCIN_PALETTES.latte.green).toBe("#40a02b");
    expect(CATPPUCCIN_PALETTES.latte.red).toBe("#d20f39");
    expect(CATPPUCCIN_PALETTES.frappe.base).toBe("#303446");
    expect(CATPPUCCIN_PALETTES.frappe.mauve).toBe("#ca9ee6");
    expect(CATPPUCCIN_PALETTES.frappe.green).toBe("#a6d189");
    expect(CATPPUCCIN_PALETTES.frappe.red).toBe("#e78284");
    expect(CATPPUCCIN_PALETTES.macchiato.base).toBe("#24273a");
    expect(CATPPUCCIN_PALETTES.macchiato.mauve).toBe("#c6a0f6");
    expect(CATPPUCCIN_PALETTES.macchiato.green).toBe("#a6da95");
    expect(CATPPUCCIN_PALETTES.macchiato.red).toBe("#ed8796");
    expect(CATPPUCCIN_PALETTES.mocha.base).toBe("#1e1e2e");
    expect(CATPPUCCIN_PALETTES.mocha.mauve).toBe("#cba6f7");
    expect(CATPPUCCIN_PALETTES.mocha.green).toBe("#a6e3a1");
    expect(CATPPUCCIN_PALETTES.mocha.red).toBe("#f38ba8");
  });

  test("derives Catppuccin diff backgrounds from official semantic tokens", () => {
    const latte = resolveTheme("catppuccin-latte", null);
    const mocha = resolveTheme("catppuccin-mocha", null);

    expect(latte.addedBg).toBe(blendHex(CATPPUCCIN_PALETTES.latte.green, latte.contextBg, 0.15));
    expect(latte.removedBg).toBe(blendHex(CATPPUCCIN_PALETTES.latte.red, latte.contextBg, 0.15));
    expect(latte.addedContentBg).toBe(
      blendHex(CATPPUCCIN_PALETTES.latte.green, latte.contextBg, 0.25),
    );
    expect(latte.removedContentBg).toBe(
      blendHex(CATPPUCCIN_PALETTES.latte.red, latte.contextBg, 0.25),
    );
    expect(mocha.addedBg).toBe(blendHex(CATPPUCCIN_PALETTES.mocha.green, mocha.contextBg, 0.15));
    expect(mocha.removedBg).toBe(blendHex(CATPPUCCIN_PALETTES.mocha.red, mocha.contextBg, 0.15));
    expect(mocha.addedContentBg).toBe(
      blendHex(CATPPUCCIN_PALETTES.mocha.green, mocha.contextBg, 0.25),
    );
    expect(mocha.removedContentBg).toBe(
      blendHex(CATPPUCCIN_PALETTES.mocha.red, mocha.contextBg, 0.25),
    );
  });

  test("keeps Catppuccin add and remove rows semantically distinct", () => {
    for (const theme of [
      resolveTheme("catppuccin-latte", null),
      resolveTheme("catppuccin-frappe", null),
      resolveTheme("catppuccin-macchiato", null),
      resolveTheme("catppuccin-mocha", null),
    ]) {
      expect(theme.addedBg).not.toBe(theme.removedBg);
      expect(hexColorDistance(theme.addedBg, theme.contextBg)).toBeGreaterThan(0);
      expect(hexColorDistance(theme.removedBg, theme.contextBg)).toBeGreaterThan(0);
      expect(hexColorDistance(theme.addedContentBg, theme.contextBg)).toBeGreaterThan(
        hexColorDistance(theme.addedBg, theme.contextBg),
      );
      expect(hexColorDistance(theme.removedContentBg, theme.contextBg)).toBeGreaterThan(
        hexColorDistance(theme.removedBg, theme.contextBg),
      );
    }
  });

  test("maps Catppuccin syntax roles to documented editor tokens", () => {
    const latte = resolveTheme("catppuccin-latte", null);
    const mocha = resolveTheme("catppuccin-mocha", null);

    expect(latte.syntaxTheme).toBe("catppuccin-latte");
    expect(mocha.syntaxTheme).toBe("catppuccin-mocha");
    expect(latte.syntaxColors).toMatchObject({
      keyword: CATPPUCCIN_PALETTES.latte.mauve,
      string: CATPPUCCIN_PALETTES.latte.green,
      comment: CATPPUCCIN_PALETTES.latte.overlay2,
      number: CATPPUCCIN_PALETTES.latte.peach,
      function: CATPPUCCIN_PALETTES.latte.blue,
      property: CATPPUCCIN_PALETTES.latte.blue,
      type: CATPPUCCIN_PALETTES.latte.yellow,
      punctuation: CATPPUCCIN_PALETTES.latte.overlay2,
    });
    expect(mocha.syntaxColors).toMatchObject({
      keyword: CATPPUCCIN_PALETTES.mocha.mauve,
      string: CATPPUCCIN_PALETTES.mocha.green,
      comment: CATPPUCCIN_PALETTES.mocha.overlay2,
      number: CATPPUCCIN_PALETTES.mocha.peach,
      function: CATPPUCCIN_PALETTES.mocha.blue,
      property: CATPPUCCIN_PALETTES.mocha.blue,
      type: CATPPUCCIN_PALETTES.mocha.yellow,
      punctuation: CATPPUCCIN_PALETTES.mocha.overlay2,
    });
  });

  test("resolves Zenburn by theme id with its tuned dark palette", () => {
    const zenburn = resolveTheme("zenburn", null);

    expect(zenburn.id).toBe("zenburn");
    expect(zenburn.label).toBe("Zenburn");
    expect(zenburn.appearance).toBe("dark");
    expect(zenburn.background).toBe("#3f3f3f");
    expect(zenburn.text).toBe("#dcdccc");
    expect(zenburn.syntaxColors).toMatchObject({
      keyword: "#f0dfaf",
      string: "#dca3a3",
      comment: "#60b48a",
      function: "#94bff3",
      type: "#94bff3",
    });
  });

  test("withSyntaxTheme derives diff surfaces from bundled Shiki editor backgrounds", () => {
    const graphite = resolveTheme("graphite", null);
    const dracula = withSyntaxTheme(graphite, "dracula", "editor-surface");
    const githubLight = withSyntaxTheme(graphite, "github-light", "editor-surface");

    expect(dracula.syntaxTheme).toBe("dracula");
    expect(dracula.background).toBe("#282a36");
    expect(dracula.contextBg).toBe("#282a36");
    expect(dracula.contextContentBg).toBe("#282a36");
    expect(dracula.panelAlt).not.toBe(graphite.panelAlt);
    expect(contrastRatio(dracula.text, dracula.panelAlt)).toBeGreaterThanOrEqual(4.5);
    expect(dracula.addedSignColor).toBe("#50fa7b");
    expect(dracula.removedSignColor).toBe("#ff5555");
    expect(dracula.accent).toBe("#8be9fd");
    expect(dracula.addedBg).toBe(blendHex("#50fa7b", "#282a36", 0.2));
    expect(dracula.removedBg).toBe(blendHex("#ff5555", "#282a36", 0.2));
    expect(hexColorDistance(dracula.addedContentBg, dracula.contextBg)).toBeGreaterThan(
      hexColorDistance(dracula.addedBg, dracula.contextBg),
    );
    expect(hexColorDistance(dracula.removedContentBg, dracula.contextBg)).toBeGreaterThan(
      hexColorDistance(dracula.removedBg, dracula.contextBg),
    );
    expect(contrastRatio(dracula.lineNumberFg, dracula.lineNumberBg)).toBeGreaterThanOrEqual(4.5);

    expect(githubLight.syntaxTheme).toBe("github-light");
    expect(githubLight.background).toBe("#ffffff");
    expect(githubLight.contextBg).toBe("#ffffff");
    expect(githubLight.panelAlt).not.toBe(graphite.panelAlt);
    expect(githubLight.syntaxColors.default).toBe("#24292e");
    expect(githubLight.addedSignColor).toBe("#28a745");
    expect(githubLight.removedSignColor).toBe("#d73a49");
    expect(githubLight.accent).toBe("#005cc5");
    expect(githubLight.addedBg).toBe(blendHex("#28a745", "#ffffff", 0.12));
    expect(githubLight.removedBg).toBe(blendHex("#d73a49", "#ffffff", 0.12));
    expect(
      contrastRatio(githubLight.lineNumberFg, githubLight.lineNumberBg),
    ).toBeGreaterThanOrEqual(4.5);
  });

  test("withSyntaxTheme keeps derived bundled Shiki backgrounds usable", () => {
    const graphite = resolveTheme("graphite", null);
    const failures = BUNDLED_SHIKI_THEME_IDS.flatMap((syntaxTheme) => {
      const theme = withSyntaxTheme(graphite, syntaxTheme, "editor-surface");
      const checks = [
        {
          label: `${syntaxTheme} line number`,
          foreground: theme.lineNumberFg,
          background: theme.lineNumberBg,
        },
        {
          label: `${syntaxTheme} code foreground`,
          foreground: theme.syntaxColors.default,
          background: theme.contextBg,
        },
        {
          label: `${syntaxTheme} metadata foreground`,
          foreground: theme.text,
          background: theme.panelAlt,
        },
        {
          label: `${syntaxTheme} added sign`,
          foreground: theme.addedSignColor,
          background: theme.addedBg,
          minimum: 2.4,
        },
        {
          label: `${syntaxTheme} removed sign`,
          foreground: theme.removedSignColor,
          background: theme.removedBg,
          minimum: 2.4,
        },
      ];

      return [
        ...themeContrastFailures(checks),
        ...(theme.addedBg === theme.contextBg ? [`${syntaxTheme} added bg matches context`] : []),
        ...(theme.removedBg === theme.contextBg
          ? [`${syntaxTheme} removed bg matches context`]
          : []),
      ];
    });

    expect(failures).toEqual([]);
  });

  test("withSyntaxTheme defaults syntax themes to Shiki editor and diff colors", () => {
    const graphite = resolveTheme("graphite", null);
    const shikiSurface = withSyntaxTheme(graphite, "dracula");

    expect(shikiSurface.syntaxTheme).toBe("dracula");
    expect(shikiSurface.background).toBe("#282a36");
    expect(shikiSurface.contextBg).toBe("#282a36");
    expect(shikiSurface.panelAlt).not.toBe(graphite.panelAlt);
    expect(shikiSurface.syntaxColors.default).toBe("#f8f8f2");
    expect(shikiSurface.addedSignColor).toBe("#50fa7b");
    expect(shikiSurface.removedSignColor).toBe("#ff5555");
    expect(shikiSurface.addedBg).toBe(blendHex("#50fa7b", "#282a36", 0.2));
  });

  test("withSyntaxTheme can keep syntax themes token-only through explicit policy", () => {
    const graphite = resolveTheme("graphite", null);
    const tokenOnly = withSyntaxTheme(graphite, "dracula", "tokens-only");

    expect(tokenOnly.syntaxTheme).toBe("dracula");
    expect(tokenOnly.background).toBe(graphite.background);
    expect(tokenOnly.contextBg).toBe(graphite.contextBg);
    expect(tokenOnly.addedBg).toBe(graphite.addedBg);
  });

  test("withSyntaxTheme leaves unknown syntax theme names on the UI palette", () => {
    const graphite = resolveTheme("graphite", null);
    const custom = withSyntaxTheme(graphite, "custom-theme-file");

    expect(custom.syntaxTheme).toBe("custom-theme-file");
    expect(custom.background).toBe(graphite.background);
    expect(custom.contextBg).toBe(graphite.contextBg);
    expect(custom.syntaxColors.default).toBe(graphite.syntaxColors.default);
    expect(custom.addedSignColor).toBe(graphite.addedSignColor);
    expect(custom.addedBg).toBe(graphite.addedBg);
  });

  test("withTransparentBackground only swaps painted background fields", () => {
    const theme = resolveTheme("graphite", null);
    const transparent = withTransparentBackground(theme);

    expect(transparent).toMatchObject({
      background: TRANSPARENT_BACKGROUND,
      panel: TRANSPARENT_BACKGROUND,
      panelAlt: TRANSPARENT_BACKGROUND,
      addedBg: TRANSPARENT_BACKGROUND,
      removedBg: TRANSPARENT_BACKGROUND,
      contextBg: TRANSPARENT_BACKGROUND,
      addedContentBg: TRANSPARENT_BACKGROUND,
      removedContentBg: TRANSPARENT_BACKGROUND,
      contextContentBg: TRANSPARENT_BACKGROUND,
      lineNumberBg: TRANSPARENT_BACKGROUND,
      selectedHunk: TRANSPARENT_BACKGROUND,
      noteBackground: TRANSPARENT_BACKGROUND,
      noteTitleBackground: TRANSPARENT_BACKGROUND,
    });
    expect(transparent.id).toBe(theme.id);
    expect(transparent.label).toBe(theme.label);
    expect(transparent.text).toBe(theme.text);
    expect(transparent.muted).toBe(theme.muted);
    expect(transparent.addedSignColor).toBe(theme.addedSignColor);
    expect(transparent.removedSignColor).toBe(theme.removedSignColor);
    expect(transparent.syntaxColors).toBe(theme.syntaxColors);
    expect(theme.background).not.toBe(TRANSPARENT_BACKGROUND);
  });

  test("withTransparentSurfaces keeps added/removed row tints", () => {
    const theme = resolveTheme("graphite", null);
    const transparent = withTransparentSurfaces(theme);

    expect(transparent).toMatchObject({
      background: TRANSPARENT_BACKGROUND,
      panel: TRANSPARENT_BACKGROUND,
      panelAlt: TRANSPARENT_BACKGROUND,
      contextBg: TRANSPARENT_BACKGROUND,
      contextContentBg: TRANSPARENT_BACKGROUND,
      lineNumberBg: TRANSPARENT_BACKGROUND,
    });
    expect(transparent.addedBg).toBe(theme.addedBg);
    expect(transparent.removedBg).toBe(theme.removedBg);
    expect(transparent.movedAddedBg).toBe(theme.movedAddedBg);
    expect(transparent.movedRemovedBg).toBe(theme.movedRemovedBg);
    expect(transparent.addedContentBg).toBe(theme.addedContentBg);
    expect(transparent.removedContentBg).toBe(theme.removedContentBg);
    expect(transparent.syntaxColors).toBe(theme.syntaxColors);
  });
});
