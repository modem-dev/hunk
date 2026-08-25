import type { SupportedLanguages } from "@pierre/diffs";
import type { ExtensionFileLanguageMatcher } from "../../extension-api/types";

/**
 * Records file-language selectors without loading the diff engine.
 *
 * Registration happens during startup, on every invocation, while the selectors are only read
 * when a changeset is built. Compiling them eagerly would pull the whole diff engine — and its
 * syntax grammars — into commands that never render anything, so this module holds them as plain
 * data and `fileLanguageLookup` compiles them at the first lookup for each registration version.
 *
 * Keep this module free of runtime imports from `@pierre/diffs`; that is the only thing making the
 * deferral worth anything.
 */

export interface FileLanguageRegistration {
  matcher: ExtensionFileLanguageMatcher;
  language: string;
  /** Prevents a broader extension selector from replacing a core syntax guarantee. */
  reserved?: boolean;
}

export interface FileLanguageRegistrationSnapshot {
  version: number;
  registrations: readonly FileLanguageRegistration[];
}

// Pierre omits these TypeScript extensions, so Hunk registers and reserves them itself.
const HUNK_CUSTOM_EXTENSIONS: Record<string, SupportedLanguages> = {
  mts: "typescript",
  cts: "typescript",
};

/** Extensions Hunk refuses to yield to an extension, in dotless lowercase form. */
export const BUILT_IN_FILE_LANGUAGE_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(HUNK_CUSTOM_EXTENSIONS),
);

const builtInFileLanguages: FileLanguageRegistration[] = Object.entries(HUNK_CUSTOM_EXTENSIONS).map(
  ([value, language]) => ({
    matcher: { kind: "extension", value },
    language,
    reserved: true,
  }),
);

let registrationVersion = 0;
let activeFileLanguages: readonly FileLanguageRegistration[] = builtInFileLanguages;

/** Copy registrations into the active set and invalidate compiled selectors. */
function setActiveFileLanguages(registrations: readonly FileLanguageRegistration[]): void {
  activeFileLanguages = registrations.map((registration) => ({
    matcher: { ...registration.matcher },
    language: registration.language,
    reserved: registration.reserved,
  }));
  registrationVersion += 1;
}

/**
 * Atomically replace extension-contributed selectors while retaining Hunk's reserved mappings.
 *
 * Reloads call this even when no selectors remain, so removed extensions cannot leave stale rules
 * or compiled globs active in the process.
 */
export function replaceExtensionFileLanguages(
  registrations: readonly FileLanguageRegistration[],
): void {
  setActiveFileLanguages([...builtInFileLanguages, ...registrations]);
}

/** Restore the active set captured before a candidate session bootstrap began. */
export function restoreFileLanguageRegistrations(snapshot: FileLanguageRegistrationSnapshot): void {
  setActiveFileLanguages(snapshot.registrations);
}

/** Return the current immutable registration set and its compilation version. */
export function fileLanguageRegistrationSnapshot(): FileLanguageRegistrationSnapshot {
  return { version: registrationVersion, registrations: activeFileLanguages };
}
