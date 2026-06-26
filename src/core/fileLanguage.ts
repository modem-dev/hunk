import {
  getFiletypeFromFileName,
  setCustomExtension,
  type SupportedLanguages,
} from "@pierre/diffs";

/**
 * File extensions Pierre's built-in map does not cover but that Hunk wants to
 * highlight as an existing language.
 *
 * Pierre maps `mjs`/`cjs` to JavaScript but omits the TypeScript equivalents
 * `mts`/`cts`, so they fall back to plain text. Registering them as custom
 * extensions teaches both our own language detection and Pierre's renderer
 * (including its highlight workers, which receive the custom-extension map) to
 * treat them as TypeScript.
 */
const HUNK_CUSTOM_EXTENSIONS: Record<string, SupportedLanguages> = {
  mts: "typescript",
  cts: "typescript",
};

for (const [extension, language] of Object.entries(HUNK_CUSTOM_EXTENSIONS)) {
  setCustomExtension(extension, language);
}

/**
 * Resolve the highlight language for a file path, applying Hunk's custom
 * extension mappings on top of Pierre's built-in detection.
 */
export function getLanguageForFileName(fileName: string): SupportedLanguages {
  return getFiletypeFromFileName(fileName);
}
