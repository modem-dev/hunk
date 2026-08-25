import { describe, expect, test } from "bun:test";
import type { NamedCustomThemeConfig } from "../../extension-api/types";
import type { RegisteredCustomTheme } from "./customThemes";
import { collectSessionCustomThemes, describeCustomThemeIdIssue } from "./customThemes";

/** Build one extension theme registration the way the extension host records it. */
function createTestRegisteredTheme(
  extensionId: string,
  theme: NamedCustomThemeConfig,
): RegisteredCustomTheme {
  return { extensionId, theme };
}

describe("custom theme ids", () => {
  test("accepts lowercase kebab and word ids", () => {
    expect(describeCustomThemeIdIssue("custom")).toBeUndefined();
    expect(describeCustomThemeIdIssue("ocean-dark")).toBeUndefined();
    expect(describeCustomThemeIdIssue("team_theme2")).toBeUndefined();
  });

  test("rejects ids that are not lowercase kebab or word shaped", () => {
    for (const id of ["", "Ocean", "ocean dark", "ocean.dark", "-ocean", "ocean-"]) {
      expect(describeCustomThemeIdIssue(id)).toBe(
        id === ""
          ? "theme ids must be non-empty strings"
          : "theme ids must be lowercase words separated by - or _",
      );
    }
  });

  test("rejects ids that belong to built-in themes", () => {
    expect(describeCustomThemeIdIssue("dracula")).toBe("that id belongs to a built-in theme");
    expect(describeCustomThemeIdIssue("github-dark-default")).toBe(
      "that id belongs to a built-in theme",
    );
    expect(describeCustomThemeIdIssue("auto")).toBe("that id belongs to a built-in theme");
  });
});

describe("session custom themes", () => {
  test("keeps config themes first and appends extension themes in registry order", () => {
    const result = collectSessionCustomThemes(
      [{ id: "custom" }, { id: "team" }],
      [
        createTestRegisteredTheme("pack", { id: "ocean" }),
        createTestRegisteredTheme("pack", { id: "sunset" }),
      ],
    );

    expect(result.themes.map((theme) => theme.id)).toEqual(["custom", "team", "ocean", "sunset"]);
    expect(result.notices).toEqual([]);
  });

  test("lets config themes win over extension themes with the same id", () => {
    const result = collectSessionCustomThemes(
      [{ id: "ocean", accent: "#123456" }],
      [createTestRegisteredTheme("pack", { id: "ocean", accent: "#654321" })],
    );

    expect(result.themes).toEqual([{ id: "ocean", accent: "#123456" }]);
    expect(result.notices).toEqual([
      {
        key: "theme:collision:extension pack:ocean",
        message: 'Skipped theme "ocean" from extension pack • config already defines it',
      },
    ]);
  });

  test("keeps the first extension theme when two extensions claim one id", () => {
    const result = collectSessionCustomThemes(
      [],
      [
        createTestRegisteredTheme("first", { id: "ocean", accent: "#111111" }),
        createTestRegisteredTheme("second", { id: "ocean", accent: "#222222" }),
      ],
    );

    expect(result.themes).toEqual([{ id: "ocean", accent: "#111111" }]);
    expect(result.notices).toEqual([
      {
        key: "theme:collision:extension second:ocean",
        message: 'Skipped theme "ocean" from extension second • extension first already defines it',
      },
    ]);
  });

  test("skips extension themes with unusable ids instead of failing startup", () => {
    const result = collectSessionCustomThemes(
      [],
      [
        createTestRegisteredTheme("pack", { id: "Ocean" }),
        createTestRegisteredTheme("pack", { id: "nord" }),
        createTestRegisteredTheme("pack", { id: "ocean" }),
      ],
    );

    expect(result.themes.map((theme) => theme.id)).toEqual(["ocean"]);
    expect(result.notices.map((notice) => notice.message)).toEqual([
      'Skipped theme "Ocean" from extension pack • theme ids must be lowercase words separated by - or _',
      'Skipped theme "nord" from extension pack • that id belongs to a built-in theme',
    ]);
  });

  test("returns an empty list when nothing contributes a theme", () => {
    expect(collectSessionCustomThemes()).toEqual({ themes: [], notices: [] });
  });
});

describe("extension theme field validation", () => {
  /** Register one extension theme, bypassing the type system the way JS does. */
  function collectExtensionTheme(theme: unknown) {
    return collectSessionCustomThemes(
      [],
      [createTestRegisteredTheme("paint-ext", theme as NamedCustomThemeConfig)],
    );
  }

  test("keeps a fully valid extension theme", () => {
    const result = collectExtensionTheme({
      id: "midnight-review",
      label: "Midnight Review",
      base: "catppuccin-mocha",
      accent: "#7FD1FF",
      syntaxScopes: { "keyword.operator": "#7FD1FF" },
    });

    expect(result.notices).toEqual([]);
    expect(result.themes).toHaveLength(1);
    // Normalized exactly like a TOML theme: colors lowercased, base resolved.
    expect(result.themes[0]?.accent).toBe("#7fd1ff");
    expect(result.themes[0]?.syntaxScopes).toEqual({ "keyword.operator": "#7fd1ff" });
  });

  test("drops a theme whose color is not a hex string", () => {
    // The exact shape that used to reach OpenTUI's FFI and abort rendering.
    const result = collectExtensionTheme({ id: "bad-theme", background: 12345 });

    expect(result.themes).toEqual([]);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]?.message).toBe(
      'Skipped theme "bad-theme" from extension paint-ext • background must be a hex color like #112233',
    );
  });

  test("drops a theme whose color is a malformed hex string", () => {
    const result = collectExtensionTheme({ id: "bad-theme", accent: "#xyz" });

    expect(result.themes).toEqual([]);
    expect(result.notices[0]?.message).toContain("accent must be a hex color like #112233");
  });

  test("drops a theme whose field is a non-string object", () => {
    const result = collectExtensionTheme({ id: "bad-theme", text: { not: "a string" } });

    expect(result.themes).toEqual([]);
    expect(result.notices[0]?.message).toContain("text must be a hex color like #112233");
  });

  test("drops a theme whose label is not a string", () => {
    const result = collectExtensionTheme({ id: "bad-theme", label: 7 });

    expect(result.themes).toEqual([]);
    expect(result.notices[0]?.message).toContain("label must be a string");
  });

  test("drops a theme whose base is not a bundled Shiki id", () => {
    const result = collectExtensionTheme({ id: "bad-theme", base: "not-a-real-theme" });

    expect(result.themes).toEqual([]);
    expect(result.notices[0]?.message).toContain("base must be a built-in theme id");
  });

  test("drops a theme with a malformed syntaxScopes color", () => {
    const result = collectExtensionTheme({
      id: "bad-theme",
      syntaxScopes: { "keyword.operator": "cyan" },
    });

    expect(result.themes).toEqual([]);
    expect(result.notices[0]?.message).toContain(
      "syntaxScopes.keyword.operator must be a hex color like #112233",
    );
  });

  test("drops a theme whose syntaxScopes is not a table", () => {
    const result = collectExtensionTheme({ id: "bad-theme", syntaxScopes: ["#112233"] });

    expect(result.themes).toEqual([]);
    expect(result.notices[0]?.message).toContain("syntaxScopes must be an object");
  });

  test("drops a theme with a malformed legacy syntax color", () => {
    const result = collectExtensionTheme({ id: "bad-theme", syntax: { keyword: 42 } });

    expect(result.themes).toEqual([]);
    expect(result.notices[0]?.message).toContain("syntax.keyword must be a hex color like #112233");
  });

  test("drops a theme that is not an object at all", () => {
    const result = collectSessionCustomThemes(
      [],
      [{ extensionId: "paint-ext", theme: "nope" as unknown as NamedCustomThemeConfig }],
    );

    expect(result.themes).toEqual([]);
    // No usable id, so the id rule reports first.
    expect(result.notices).toHaveLength(1);
  });

  test("keeps valid themes when a sibling registration is malformed", () => {
    const result = collectSessionCustomThemes(
      [],
      [
        createTestRegisteredTheme("paint-ext", { id: "bad-theme", accent: 1 } as never),
        createTestRegisteredTheme("paint-ext", { id: "good-theme", accent: "#112233" }),
      ],
    );

    expect(result.themes.map((theme) => theme.id)).toEqual(["good-theme"]);
    expect(result.notices).toHaveLength(1);
  });
});
