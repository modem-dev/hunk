import { describe, expect, test } from "bun:test";
import type { RegisteredTheme } from "../extensions/types";
import { collectSessionCustomThemes, describeCustomThemeIdIssue } from "./customThemes";
import type { NamedCustomThemeConfig } from "./types";

/** Build one extension theme registration the way the extension host records it. */
function createTestRegisteredTheme(
  extensionId: string,
  theme: NamedCustomThemeConfig,
): RegisteredTheme {
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
