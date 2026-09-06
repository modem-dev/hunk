import { describe, expect, test } from "bun:test";
import { createTestCustomThemes } from "../../../../test/helpers/theme-helpers";
import { blendHex, contrastRatio, hexColorDistance } from "./lib/color";
import {
  BUNDLED_SHIKI_THEME_IDS,
  getBundledShikiThemeBackground,
  getBundledShikiThemeDiffColors,
} from "../core/theme/catalog";
import { resolveWordDiffHighlightBg } from "./diff/diffRows";
import {
  availableThemeIds,
  availableThemes,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  MIN_DIFF_SIGN_CONTRAST,
  MIN_EMPHASIS_SEPARATION,
  readableDiffSign,
  resolveTheme,
  TRANSPARENT_BACKGROUND,
  withTransparentSurfaces,
} from "./themes";

const MIN_READABLE_TEXT_CONTRAST = 4.5;
const MAX_RESCUE_HUE_DRIFT = 2;
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

/** Return the HSL hue in degrees for a #rrggbb color, or null when achromatic. */
function hexHueDegrees(hex: string): number | null {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) {
    return null;
  }
  const chroma = max - min;
  const segment =
    max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  return (segment * 60 + 360) % 360;
}

/** Return the shortest angular distance between two hues in degrees. */
function hueDistance(left: number, right: number) {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

/** List each bundled theme's catalog diff accents beside the derived theme slots. */
function bundledDiffSignSlots(themeId: string) {
  const background = getBundledShikiThemeBackground(themeId) ?? "#0d1117";
  const diffColors = getBundledShikiThemeDiffColors(themeId);
  const theme = resolveTheme(themeId, null);
  const slots: Array<{ slot: string; source: string; derived: string }> = [];
  if (diffColors?.added) {
    slots.push({ slot: "added", source: diffColors.added, derived: theme.addedSignColor });
  }
  if (diffColors?.removed) {
    slots.push({ slot: "removed", source: diffColors.removed, derived: theme.removedSignColor });
  }
  if (diffColors?.modified) {
    slots.push({ slot: "modified", source: diffColors.modified, derived: theme.accent });
  }
  return { background, slots };
}

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
    expect(dark.addedSignColor).toBe("#2ea043");
    expect(dark.removedSignColor).toBe("#f85149");
    expect(dark.addedBg).toBe(blendHex("#2ea043", "#0d1117", 0.14));
    expect(dark.removedBg).toBe(blendHex("#f85149", "#0d1117", 0.2));

    expect(light.background).toBe("#ffffff");
    expect(light.syntaxColors.default).toBe("#1f2328");
    expect(light.addedSignColor).toBe("#116329");
    expect(light.removedSignColor).toBe("#cf222e");
    expect(light.addedBg).toBe(blendHex("#116329", "#ffffff", 0.12));
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

  test("keeps catalog diff accents untouched when they already meet the sign contrast floor", () => {
    const failures = BUNDLED_SHIKI_THEME_IDS.flatMap((themeId) => {
      const { background, slots } = bundledDiffSignSlots(themeId);
      return slots.flatMap(({ slot, source, derived }) => {
        if (contrastRatio(source, background) < MIN_DIFF_SIGN_CONTRAST) {
          return [];
        }
        return derived === source ? [] : [`${themeId} ${slot}: ${source} rescued to ${derived}`];
      });
    });

    expect(failures).toEqual([]);
  });

  test("rescued diff signs keep the source accent hue and clear the contrast floor", () => {
    const failures = BUNDLED_SHIKI_THEME_IDS.flatMap((themeId) => {
      const { background, slots } = bundledDiffSignSlots(themeId);
      return slots.flatMap(({ slot, source, derived }) => {
        if (contrastRatio(source, background) >= MIN_DIFF_SIGN_CONTRAST) {
          return [];
        }
        const label = `${themeId} ${slot}: ${source} rescued to ${derived}`;
        const rescuedContrast = contrastRatio(derived, background);
        if (rescuedContrast < MIN_DIFF_SIGN_CONTRAST) {
          return [`${label} but contrast is ${rescuedContrast.toFixed(2)}`];
        }
        const sourceHue = hexHueDegrees(source);
        const derivedHue = hexHueDegrees(derived);
        if (sourceHue === null || derivedHue === null) {
          // Achromatic accents (e.g. slack-ochin's white removed slot) have no hue to keep.
          return [];
        }
        const drift = hueDistance(sourceHue, derivedHue);
        return drift <= MAX_RESCUE_HUE_DRIFT ? [] : [`${label}, hue drifted ${drift.toFixed(1)}°`];
      });
    });

    expect(failures).toEqual([]);
  });

  test("rescues diff signs with the smallest blend that clears the contrast floor", () => {
    const failures = BUNDLED_SHIKI_THEME_IDS.flatMap((themeId) => {
      const { background, slots } = bundledDiffSignSlots(themeId);
      return slots.flatMap(({ slot, source, derived }) => {
        if (contrastRatio(source, background) >= MIN_DIFF_SIGN_CONTRAST) {
          return [];
        }
        const minimalRescues = ["#000000", "#ffffff"].flatMap((anchor) => {
          for (let amount = 0.02; amount < 1; amount += 0.02) {
            const candidate = blendHex(anchor, source, amount);
            if (contrastRatio(candidate, background) >= MIN_DIFF_SIGN_CONTRAST) {
              return [candidate];
            }
          }
          return [];
        });
        return minimalRescues.includes(derived)
          ? []
          : [
              `${themeId} ${slot}: ${source} rescued to ${derived}, expected a minimal rescue (${minimalRescues.join(", ")})`,
            ];
      });
    });

    expect(failures).toEqual([]);
  });

  test("nudges catppuccin-latte's near-miss green instead of washing it out", () => {
    expect(resolveTheme("catppuccin-latte", null).addedSignColor).toBe("#3f9d2a");
  });

  test("readableDiffSign upholds the contrast floor on mid-luminance backgrounds", () => {
    const rescued = readableDiffSign("#b0b0b0", "#aaaaaa");
    expect(contrastRatio(rescued, "#aaaaaa")).toBeGreaterThanOrEqual(MIN_DIFF_SIGN_CONTRAST);
  });

  test("keeps the rendered word-level emphasis separated and readable on every bundled theme", () => {
    const failures = BUNDLED_SHIKI_THEME_IDS.flatMap((themeId) => {
      const theme = resolveTheme(themeId, null);
      return (
        [
          ["added", theme.addedBg, theme.addedContentBg, theme.addedSignColor],
          ["removed", theme.removedBg, theme.removedContentBg, theme.removedSignColor],
        ] as const
      ).flatMap(([slot, rowBackground, contentBackground, signColor]) => {
        const rendered = resolveWordDiffHighlightBg(contentBackground, rowBackground, signColor);
        const problems: string[] = [];
        if (rendered !== contentBackground) {
          problems.push(`renderer rewrote ${contentBackground} to ${rendered}`);
        }
        const separation = hexColorDistance(rowBackground, rendered);
        if (separation < MIN_EMPHASIS_SEPARATION) {
          problems.push(`separation ${separation} vs ${rowBackground}`);
        }
        const textContrast = contrastRatio(theme.text, rendered);
        if (textContrast + 0.005 < MIN_READABLE_TEXT_CONTRAST) {
          problems.push(`text contrast ${textContrast.toFixed(2)} on ${rendered}`);
        }
        return problems.map((problem) => `${themeId} ${slot}: ${problem}`);
      });
    });

    expect(failures).toEqual([]);
  });

  test("layers custom theme overrides on a bundled base", () => {
    const custom = resolveTheme(
      "custom",
      null,
      createTestCustomThemes({
        base: "catppuccin-mocha",
        label: "My Theme",
        text: "#ffffff",
        syntaxScopes: { "keyword.control": "#ff00ff" },
      }),
    );

    expect(custom.id).toBe("custom");
    expect(custom.label).toBe("My Theme");
    expect(custom.background).toBe(resolveTheme("catppuccin-mocha", null).background);
    expect(custom.text).toBe("#ffffff");
    expect(custom.syntaxTheme).toBe("catppuccin-mocha");
    expect(custom.syntaxScopeOverrides).toEqual({ "keyword.control": "#ff00ff" });
    expect(custom.syntaxColors).toBe(resolveTheme("catppuccin-mocha", null).syntaxColors);
  });

  test("lists custom themes after the bundled themes in declaration order", () => {
    const customThemes = [
      { id: "custom", base: "nord" },
      { id: "ocean", base: "nord", label: "Ocean" },
      { id: "sunset", base: "github-light-default" },
    ];

    expect(availableThemeIds(customThemes)).toEqual([
      ...BUNDLED_SHIKI_THEME_IDS,
      "custom",
      "ocean",
      "sunset",
    ]);
    expect(availableThemes(customThemes).map((theme) => [theme.id, theme.label])).toEqual([
      ...BUNDLED_SHIKI_THEME_IDS.map((themeId) => [themeId, themeId]),
      // Named themes label themselves by id; the original single-slot theme keeps "Custom".
      ["custom", "Custom"],
      ["ocean", "Ocean"],
      ["sunset", "sunset"],
    ]);
  });

  test("resolves each custom theme by its own id", () => {
    const customThemes = [
      { id: "ocean", base: "nord", accent: "#123456" },
      { id: "sunset", base: "github-light-default", accent: "#654321" },
    ];

    expect(resolveTheme("ocean", null, customThemes).accent).toBe("#123456");
    expect(resolveTheme("ocean", null, customThemes).background).toBe(
      resolveTheme("nord", null).background,
    );
    expect(resolveTheme("sunset", null, customThemes).accent).toBe("#654321");
    // Unknown ids stay on the built-in fallback instead of picking an unrelated custom theme.
    expect(resolveTheme("missing", null, customThemes).id).toBe(DEFAULT_DARK_THEME_ID);
    expect(resolveTheme("auto", "light", customThemes).id).toBe(DEFAULT_LIGHT_THEME_ID);
  });

  test("prefers a custom theme over a deprecated built-in alias of the same id", () => {
    const customThemes = [{ id: "midnight", base: "nord", accent: "#123456" }];

    expect(resolveTheme("midnight", null, customThemes).id).toBe("midnight");
    expect(resolveTheme("midnight", null).id).toBe("github-dark-dimmed");
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
