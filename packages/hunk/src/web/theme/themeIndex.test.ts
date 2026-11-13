import { describe, expect, test } from "bun:test";
import {
  parseWebThemeIndex,
  resolveWebTheme,
  themeCustomProperties,
  themeTokenProperty,
  type WebThemeIndexV1,
} from "./themeIndex";

const INDEX: WebThemeIndexV1 = {
  formatVersion: 1,
  themes: [
    {
      id: "github-dark-default",
      label: "GitHub Dark",
      appearance: "dark",
      syntaxTheme: "github-dark-default",
      tokens: { background: "#0d1117", addedBg: "#12261e", fileNew: "#3fb950" },
    },
    {
      id: "github-light-default",
      label: "GitHub Light",
      appearance: "light",
      syntaxTheme: "github-light-default",
      tokens: { background: "#ffffff" },
    },
    {
      id: "dracula",
      label: "Dracula",
      appearance: "dark",
      syntaxTheme: "dracula",
      tokens: { background: "#282a36" },
    },
  ],
};

describe("web theme index", () => {
  test("parses only a well-formed index", () => {
    expect(parseWebThemeIndex(JSON.parse(JSON.stringify(INDEX)))).toEqual(INDEX);
    expect(parseWebThemeIndex({ formatVersion: 2, themes: [] })).toBeUndefined();
    expect(parseWebThemeIndex({ formatVersion: 1, themes: [{ id: "x" }] })).toBeUndefined();
  });

  test("prefers the stored theme and falls back by color scheme", () => {
    expect(resolveWebTheme(INDEX, "dracula", false)?.id).toBe("dracula");
    expect(resolveWebTheme(INDEX, "gone", true)?.id).toBe("github-dark-default");
    expect(resolveWebTheme(INDEX, undefined, false)?.id).toBe("github-light-default");
  });

  test("names token properties and maps Pierre and tree overrides from the same tokens", () => {
    expect(themeTokenProperty("addedBg")).toBe("--hunk-added-bg");
    const properties = themeCustomProperties(INDEX.themes[0]!);

    expect(properties["--hunk-background"]).toBe("#0d1117");
    expect(properties["--diffs-bg-addition-override"]).toBe("#12261e");
    expect(properties["--trees-git-added-color-override"]).toBe("#3fb950");
  });
});
