import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { BUNDLED_SHIKI_THEME_DIFF_COLORS } from "../packages/hunk/src/core/theme/catalog";
import {
  harvestBundledThemeDiffColors,
  harvestThemeDiffColors,
  normalizeTokenColor,
  resolveThemeCatalogPath,
} from "./generate-theme-diff-colors";

describe("normalizeTokenColor", () => {
  test("strips alpha instead of compositing it", () => {
    expect(normalizeTokenColor("#f0717890")).toBe("#f07178");
    expect(normalizeTokenColor("#C3E88D60")).toBe("#c3e88d");
  });

  test("expands shorthand hex", () => {
    expect(normalizeTokenColor("#FFF")).toBe("#ffffff");
    expect(normalizeTokenColor("#abcd")).toBe("#aabbcc");
  });

  test("rejects values that are not hex colors", () => {
    expect(normalizeTokenColor("red")).toBeUndefined();
    expect(normalizeTokenColor("#12345")).toBeUndefined();
    expect(normalizeTokenColor("rgba(0, 0, 0, 0.5)")).toBeUndefined();
  });
});

describe("harvestThemeDiffColors", () => {
  const darkBackground = "#1a1b26";

  test("prefers the gutter accent and strips VS Code's blend alpha", () => {
    const entry = harvestThemeDiffColors(
      {
        "editorGutter.addedBackground": "#C3E88D60",
        "editorGutter.deletedBackground": "#f0717860",
        "editorGutter.modifiedBackground": "#82AAFF60",
        "gitDecoration.deletedResourceForeground": "#f0717890",
      },
      "#263238",
    );
    expect(entry).toEqual({ added: "#c3e88d", removed: "#f07178", modified: "#82aaff" });
  });

  test("rejects pre-blended gutter solids and falls through to diffEditor accents", () => {
    // tokyo-night's shape: gutter tokens are row surfaces, diffEditor tokens carry the accents.
    const entry = harvestThemeDiffColors(
      {
        "editorGutter.addedBackground": "#164846",
        "editorGutter.deletedBackground": "#823c41",
        "diffEditor.insertedTextBackground": "#41a6b520",
        "diffEditor.removedTextBackground": "#db4b4b22",
      },
      darkBackground,
    );
    expect(entry).toEqual({ added: "#41a6b5", removed: "#db4b4b" });
  });

  test("rejects candidates outside the slot's hue family", () => {
    // gruvbox publishes its editor foreground as the added gitDecoration color; a beige added
    // accent must fall through and stay unset.
    const entry = harvestThemeDiffColors(
      {
        "gitDecoration.addedResourceForeground": "#ebdbb2",
        "gitDecoration.deletedResourceForeground": "#cc241d",
      },
      "#282828",
    );
    expect(entry).toEqual({ removed: "#cc241d" });
  });

  test("omits desaturated candidates such as greys and whites", () => {
    const entry = harvestThemeDiffColors(
      {
        "terminal.ansiGreen": "#77cc00",
        "terminal.ansiRed": "#D32F2F",
        "terminal.ansiBlue": "#e0e0e0",
      },
      "#ffffff",
    );
    expect(entry).toEqual({ added: "#77cc00", removed: "#d32f2f" });
  });

  test("drops themes where neither added nor removed survives", () => {
    // slack-dark's shape: yellow added/modified labels and a white deleted label.
    const entry = harvestThemeDiffColors(
      {
        "gitDecoration.addedResourceForeground": "#ECB22E",
        "gitDecoration.deletedResourceForeground": "#FFF",
        "gitDecoration.modifiedResourceForeground": "#ECB22E",
      },
      "#222222",
    );
    expect(entry).toBeUndefined();
  });

  test("keeps foreground-class accents that a background gate would reject", () => {
    // solarized-light's ansi accents sit just under the background-token contrast gate but are
    // genuine palette colors; foreground-class sources skip that gate.
    const entry = harvestThemeDiffColors(
      {
        "terminal.ansiGreen": "#859900",
        "terminal.ansiRed": "#dc322f",
        "terminal.ansiBlue": "#268bd2",
      },
      "#fdf6e3",
    );
    expect(entry).toEqual({ added: "#859900", removed: "#dc322f", modified: "#268bd2" });
  });
});

describe("checked-in catalog table", () => {
  test("resolves the catalog inside packages/hunk", async () => {
    const expected = resolve(
      import.meta.dir,
      "..",
      "packages",
      "hunk",
      "src",
      "core",
      "theme",
      "catalog.ts",
    );
    expect(resolveThemeCatalogPath()).toBe(expected);
    expect(await Bun.file(resolveThemeCatalogPath()).exists()).toBe(true);
  });

  test("matches a fresh harvest of the installed @shikijs/themes", async () => {
    expect(BUNDLED_SHIKI_THEME_DIFF_COLORS).toEqual(await harvestBundledThemeDiffColors());
  });
});

/** Read the package.json that owns a resolved module file by walking up its directories. */
async function packageJsonAbove(resolvedFile: string, packageName: string) {
  for (let directory = dirname(resolvedFile); ; directory = dirname(directory)) {
    const candidate = Bun.file(join(directory, "package.json"));
    if (await candidate.exists()) {
      const manifest = (await candidate.json()) as {
        name?: string;
        version?: string;
        dependencies?: Record<string, string>;
      };
      if (manifest.name === packageName) {
        return manifest;
      }
    }
    if (directory === dirname(directory)) {
      throw new Error(`No ${packageName} package.json above ${resolvedFile}`);
    }
  }
}

describe("pinned @shikijs/themes devDependency", () => {
  test("stays in sync with the shiki version @pierre/diffs resolves", async () => {
    const pinnedThemes = await packageJsonAbove(
      Bun.resolveSync("@shikijs/themes/nord", import.meta.dir),
      "@shikijs/themes",
    );
    const pierreEntry = Bun.resolveSync("@pierre/diffs", import.meta.dir);
    const pierreShiki = await packageJsonAbove(
      Bun.resolveSync("shiki", dirname(pierreEntry)),
      "shiki",
    );
    expect(pinnedThemes.version).toBe(pierreShiki.dependencies?.["@shikijs/themes"] ?? "");
  });
});
