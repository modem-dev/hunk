import { describe, expect, test } from "bun:test";
import { blendHex, contrastRatio, hexColorDistance } from "./lib/color";
import { BUNDLED_SHIKI_THEME_IDS } from "./lib/shikiThemes";
import {
  availableThemeIds,
  availableThemes,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  resolveTheme,
  TRANSPARENT_BACKGROUND,
  withTransparentSurfaces,
} from "./themes";

const MIN_READABLE_TEXT_CONTRAST = 4.5;
const SYNTAX_ROLES = [
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
  test("defaults to GitHub's dark theme and auto chooses GitHub light/dark", () => {
    expect(resolveTheme(undefined, null).id).toBe(DEFAULT_DARK_THEME_ID);
    expect(resolveTheme("missing", null).id).toBe(DEFAULT_DARK_THEME_ID);
    expect(resolveTheme("auto", "dark").id).toBe(DEFAULT_DARK_THEME_ID);
    expect(resolveTheme("auto", "light").id).toBe(DEFAULT_LIGHT_THEME_ID);
  });

  test("maps removed theme ids to compatible built-in themes", () => {
    expect(resolveTheme("graphite", null).id).toBe("github-dark-default");
    expect(resolveTheme("paper", null).id).toBe("github-light-default");
    expect(resolveTheme("midnight", null).id).toBe("github-dark-dimmed");
    expect(resolveTheme("ember", null).id).toBe("dark-plus");
    expect(resolveTheme("zenburn", null).id).toBe("everforest-dark");
  });

  test("exposes every bundled theme as a selectable theme", () => {
    expect(availableThemeIds()).toEqual([...BUNDLED_SHIKI_THEME_IDS]);
    expect(availableThemes().map((theme) => theme.id)).toEqual([...BUNDLED_SHIKI_THEME_IDS]);

    for (const themeId of BUNDLED_SHIKI_THEME_IDS) {
      const theme = resolveTheme(themeId, null);
      expect(theme.id).toBe(themeId);
      expect(theme.label).toBe(themeId);
      expect(theme.syntaxTheme).toBe(themeId);
      expect(theme.syntaxColors.default).toBeTruthy();
    }
  });

  test("derives GitHub default surfaces from bundled theme metadata", () => {
    const dark = resolveTheme("github-dark-default", null);
    const light = resolveTheme("github-light-default", null);

    expect(dark.background).toBe("#0d1117");
    expect(dark.syntaxColors.default).toBe("#e6edf3");
    expect(dark.addedSignColor).toBe("#3fb950");
    expect(dark.removedSignColor).toBe("#f85149");
    expect(dark.addedBg).toBe(blendHex("#3fb950", "#0d1117", 0.2));
    expect(dark.removedBg).toBe(blendHex("#f85149", "#0d1117", 0.2));

    expect(light.background).toBe("#ffffff");
    expect(light.syntaxColors.default).toBe("#1f2328");
    expect(light.addedSignColor).toBe("#1a7f37");
    expect(light.removedSignColor).toBe("#cf222e");
    expect(light.addedBg).toBe(blendHex("#1a7f37", "#ffffff", 0.12));
    expect(light.removedBg).toBe(blendHex("#cf222e", "#ffffff", 0.12));
  });

  test("contrast keeps every bundled theme diff row text and gutters readable", () => {
    const failures = BUNDLED_SHIKI_THEME_IDS.flatMap((themeId) => {
      const theme = resolveTheme(themeId, null);
      return [
        ...themeContrastFailures([
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
            minimum: 2.4,
          },
          {
            label: `${theme.id} removedSignColor/removedBg`,
            foreground: theme.removedSignColor,
            background: theme.removedBg,
            minimum: 2.4,
          },
          {
            label: `${theme.id} lineNumberFg/lineNumberBg`,
            foreground: theme.lineNumberFg,
            background: theme.lineNumberBg,
          },
        ]),
        ...(theme.addedBg === theme.contextBg ? [`${theme.id} added bg matches context`] : []),
        ...(theme.removedBg === theme.contextBg ? [`${theme.id} removed bg matches context`] : []),
      ];
    });

    expect(failures).toEqual([]);
  });

  test("contrast keeps fallback syntax colors readable on every bundled theme", () => {
    const failures = BUNDLED_SHIKI_THEME_IDS.flatMap((themeId) => {
      const theme = resolveTheme(themeId, null);
      return themeContrastFailures(
        SYNTAX_ROLES.flatMap((role) => [
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
        ]),
      );
    });

    expect(failures).toEqual([]);
  });

  test("contrast keeps every bundled theme chrome colors readable", () => {
    const failures = BUNDLED_SHIKI_THEME_IDS.flatMap((themeId) => {
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

  test("layers custom theme overrides on a bundled base", () => {
    const custom = resolveTheme("custom", null, {
      base: "catppuccin-mocha",
      label: "My Theme",
      text: "#ffffff",
      syntaxScopes: { "keyword.control": "#ff00ff" },
    });

    expect(custom.id).toBe("custom");
    expect(custom.label).toBe("My Theme");
    expect(custom.background).toBe(resolveTheme("catppuccin-mocha", null).background);
    expect(custom.text).toBe("#ffffff");
    expect(custom.syntaxTheme).toBe("catppuccin-mocha");
    expect(custom.syntaxScopeOverrides).toEqual({ "keyword.control": "#ff00ff" });
    expect(custom.syntaxColors).toBe(resolveTheme("catppuccin-mocha", null).syntaxColors);
  });

  test("withTransparentSurfaces keeps added/removed row tints", () => {
    const theme = resolveTheme("github-dark-default", null);
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
