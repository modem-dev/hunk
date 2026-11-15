import { describe, expect, test } from "bun:test";
import {
  applyWebTheme,
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

/** A stand-in element that records custom properties as a style declaration would. */
function createTestElement() {
  const properties = new Map<string, string>();
  const element = {
    properties,
    dataset: {} as Record<string, string>,
    style: {
      colorScheme: "",
      setProperty: (name: string, value: string) => void properties.set(name, value),
      removeProperty: (name: string) => void properties.delete(name),
    },
  };
  return element;
}

describe("applyWebTheme", () => {
  // Intent: moving from a theme with extra tokens to one without them must not leave the old
  // colors on the page.
  test("removes properties the new theme does not define", () => {
    const element = createTestElement();
    const rich = { ...INDEX.themes[0]!, tokens: { ...INDEX.themes[0]!.tokens, accent: "#58a6ff" } };

    applyWebTheme(element as unknown as HTMLElement, rich);
    expect(element.properties.get("--hunk-accent")).toBe("#58a6ff");
    expect(element.properties.get("--diffs-bg-addition-override")).toBe("#12261e");

    applyWebTheme(element as unknown as HTMLElement, INDEX.themes[1]!);

    expect(element.properties.has("--hunk-accent")).toBe(false);
    expect(element.properties.has("--hunk-added-bg")).toBe(false);
    expect(element.properties.has("--diffs-bg-addition-override")).toBe(false);
    expect(element.properties.get("--hunk-background")).toBe("#ffffff");
    expect(element.dataset.themeAppearance).toBe("light");
  });
});
