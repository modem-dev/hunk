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

export { getFiletypeFromFileName };
