import {
  getFiletypeFromFileName,
  registerCustomLanguage,
  setCustomExtension,
  type SupportedLanguages,
} from "@pierre/diffs";

// Shiki 3 does not bundle Odin, so load its current TextMate grammar through Pierre's custom path.
registerCustomLanguage("odin", () => import("@shikijs/langs/odin"), ["odin"]);

// Register extensions Pierre omits before performing language lookups or rendering.
const HUNK_CUSTOM_EXTENSIONS: Record<string, SupportedLanguages> = {
  mts: "typescript",
  cts: "typescript",
};

for (const [extension, language] of Object.entries(HUNK_CUSTOM_EXTENSIONS)) {
  setCustomExtension(extension, language);
}

/**
 * Extensions Hunk itself registers, in Pierre's dotless lowercase form.
 *
 * Extension-contributed mappings are skipped rather than allowed to shadow
 * these, so a third-party language pack cannot silently break TypeScript
 * highlighting for everyone.
 */
export const BUILT_IN_FILE_LANGUAGE_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(HUNK_CUSTOM_EXTENSIONS),
);

/**
 * Map one dotless, lowercased file extension to a highlight language.
 *
 * Pierre's language union is closed, but extensions supply plain strings; an
 * unknown language simply fails to match a grammar at render time, which is a
 * better failure than refusing the registration outright.
 */
export function registerFileLanguage(extension: string, language: string) {
  setCustomExtension(extension, language as SupportedLanguages);
}

export { getFiletypeFromFileName };
