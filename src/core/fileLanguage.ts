import {
  getCustomExtensionsVersion,
  getFiletypeFromFileName,
  registerCustomLanguage,
  replaceCustomExtensions,
  type LanguageRegistration,
  type SupportedLanguages,
} from "@pierre/diffs";
import type { ExtensionSyntaxLanguageLoader } from "../extension-api/types";

// Pierre omits these TypeScript extensions, so register them before lookups or rendering.
const HUNK_CUSTOM_EXTENSIONS: Record<string, SupportedLanguages> = {
  mts: "typescript",
  cts: "typescript",
};

replaceCustomExtensions(getCustomExtensionsVersion() + 1, HUNK_CUSTOM_EXTENSIONS);

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

const syntaxLanguageFailureReporters = new Map<string, (error: unknown) => void>();

/** Register one lazy extension grammar with Pierre's process-wide highlighter. */
export function registerSyntaxLanguage(
  language: string,
  loader: ExtensionSyntaxLanguageLoader,
  reportFailure?: (error: unknown) => void,
) {
  registerCustomLanguage(language, loader as () => Promise<{ default: LanguageRegistration[] }>);
  if (reportFailure) {
    syntaxLanguageFailureReporters.set(language, reportFailure);
  }
}

/** Attribute a highlight failure when its language came from an extension. */
export function reportSyntaxLanguageFailure(language: string | undefined, error: unknown) {
  if (language) {
    syntaxLanguageFailureReporters.get(language)?.(error);
  }
}

/** Replace extension mappings while preserving Hunk's own protected mappings. */
export function replaceExtensionFileLanguages(
  mappings: ReadonlyArray<{ extension: string; language: string }>,
) {
  const desired: Record<string, SupportedLanguages> = { ...HUNK_CUSTOM_EXTENSIONS };
  for (const { extension, language } of mappings) {
    desired[extension] = language as SupportedLanguages;
  }
  replaceCustomExtensions(getCustomExtensionsVersion() + 1, desired);
}

export { getFiletypeFromFileName };
