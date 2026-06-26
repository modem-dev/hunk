import { setCustomExtension, type SupportedLanguages } from "@pierre/diffs";

// Pierre omits these TypeScript extensions, so register them before lookups or rendering.
const HUNK_CUSTOM_EXTENSIONS: Record<string, SupportedLanguages> = {
  mts: "typescript",
  cts: "typescript",
};

for (const [extension, language] of Object.entries(HUNK_CUSTOM_EXTENSIONS)) {
  setCustomExtension(extension, language);
}
