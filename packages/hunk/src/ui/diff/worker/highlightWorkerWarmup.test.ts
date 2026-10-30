import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../../../test/helpers/diff-helpers";
import { createTestCustomThemes } from "../../../../../../test/helpers/theme-helpers";
import { resolveTheme } from "../../themes";
import {
  HIGHLIGHT_WARMUP_MAX_LANGUAGES,
  highlightWarmupLanguages,
  warmHighlightWorker,
} from "./highlightWorkerWarmup";

/** Build one text-language-free file list from language names in review order. */
function filesFor(languages: readonly (string | undefined)[]) {
  return languages.map((language, index) => ({
    ...createTestDiffFile({ id: `file-${index}`, path: `file-${index}` }),
    language,
  }));
}

describe("highlight worker warm-up", () => {
  test("collects distinct highlightable languages in review order, bounded", () => {
    expect(
      highlightWarmupLanguages(
        filesFor(["markdown", "typescript", "text", undefined, "markdown", "ansi", "tsx"]),
      ),
    ).toEqual(["markdown", "typescript", "tsx"]);

    const many = filesFor(Array.from({ length: 12 }, (_, index) => `lang-${index}`));
    expect(highlightWarmupLanguages(many)).toHaveLength(HIGHLIGHT_WARMUP_MAX_LANGUAGES);

    const [binary] = filesFor(["typescript"]);
    expect(highlightWarmupLanguages([{ ...binary!, isBinary: true }])).toEqual([]);
    expect(highlightWarmupLanguages([{ ...binary!, isTooLarge: true }])).toEqual([]);
  });

  test("preloads one grammar per message with the resolved syntax theme", async () => {
    const preloads: Array<{ language: string; theme: string }> = [];
    const warmed = warmHighlightWorker(
      { files: filesFor(["typescript", "markdown"]), theme: resolveTheme("nord", null) },
      async (input) => {
        preloads.push(input);
        throw new Error("swallowed");
      },
    );
    await Promise.resolve();

    expect(warmed).toEqual(["typescript", "markdown"]);
    expect(preloads).toEqual([
      { language: "typescript", theme: "nord" },
      { language: "markdown", theme: "nord" },
    ]);
  });

  test("skips warm-up for scope-override themes that must highlight inline", () => {
    let preloads = 0;
    const theme = resolveTheme(
      "custom",
      null,
      createTestCustomThemes({ base: "nord", syntaxScopes: { keyword: "#abcdef" } }),
    );
    expect(
      warmHighlightWorker({ files: filesFor(["typescript"]), theme }, async () => {
        preloads += 1;
      }),
    ).toEqual([]);
    expect(preloads).toBe(0);
  });
});
