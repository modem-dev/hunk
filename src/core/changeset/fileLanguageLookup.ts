import { getFiletypeFromFileName, type SupportedLanguages } from "@pierre/diffs";
import { fileLanguageRegistrationSnapshot, type FileLanguageRegistration } from "./fileLanguage";

/**
 * Resolves a path to a highlight language, compiling the current registration set on demand.
 *
 * Importing this module loads the diff engine, so call it from changeset construction, never from
 * startup. A registration version change atomically replaces compiled selectors, which keeps
 * extension reloads from retaining rules that were removed.
 */

interface AppliedFileLanguageRegistration extends FileLanguageRegistration {
  glob?: Bun.Glob;
}

let appliedRegistrationVersion = -1;
let appliedFileLanguages: AppliedFileLanguageRegistration[] = [];

// NUL cannot occur in a filesystem path and counts as one code unit, so it keeps Bun.Glob from
// interpreting a literal backslash as a Windows separator without changing `?` or class width.
const GLOB_LITERAL_BACKSLASH = "\0";

/** Encode literal backslashes before handing a review path or pattern to platform-aware Bun.Glob. */
function encodeGlobBackslashes(value: string): string {
  return value.replaceAll("\\", GLOB_LITERAL_BACKSLASH);
}

/** Compile the current selector set once per registration version. */
function applyCurrentFileLanguages(): void {
  const snapshot = fileLanguageRegistrationSnapshot();
  if (snapshot.version === appliedRegistrationVersion) {
    return;
  }

  appliedFileLanguages = snapshot.registrations.map((registration) => ({
    ...registration,
    glob:
      registration.matcher.kind === "glob" && !registration.matcher.value.includes("\0")
        ? new Bun.Glob(encodeGlobBackslashes(registration.matcher.value))
        : undefined,
  }));
  appliedRegistrationVersion = snapshot.version;
}

/** Return the basename of one review path, whose only protocol separator is `/`. */
function basenameForLanguagePath(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Find the latest exact-filename registration for a basename. */
function filenameLanguage(basename: string): string | undefined {
  for (let index = appliedFileLanguages.length - 1; index >= 0; index -= 1) {
    const registration = appliedFileLanguages[index]!;
    if (registration.matcher.kind === "filename" && registration.matcher.value === basename) {
      return registration.language;
    }
  }
  return undefined;
}

/** Find the latest matching glob registration. */
function globLanguage(path: string, basename: string): string | undefined {
  // Decoded external patches may contain NUL even though filesystems cannot. Excluding those paths
  // keeps the one-code-unit backslash encoding collision-free; exact filename selectors still work.
  if (path.includes("\0")) {
    return undefined;
  }

  for (let index = appliedFileLanguages.length - 1; index >= 0; index -= 1) {
    const registration = appliedFileLanguages[index]!;
    if (registration.matcher.kind !== "glob") {
      continue;
    }
    const candidate = registration.matcher.target === "path" ? path : basename;
    if (registration.glob?.match(encodeGlobBackslashes(candidate))) {
      return registration.language;
    }
  }
  return undefined;
}

/** Find the longest matching extension, with the latest registration winning ties. */
function extensionLanguage(basename: string, reservedOnly = false): string | undefined {
  const lowerBasename = basename.toLowerCase();
  let best: { length: number; language: string } | undefined;

  for (let index = appliedFileLanguages.length - 1; index >= 0; index -= 1) {
    const registration = appliedFileLanguages[index]!;
    if (
      registration.matcher.kind !== "extension" ||
      (reservedOnly && registration.reserved !== true) ||
      (!reservedOnly && registration.reserved === true)
    ) {
      continue;
    }
    const extension = registration.matcher.value;
    if (
      lowerBasename.endsWith(`.${extension}`) &&
      (best === undefined || extension.length > best.length)
    ) {
      best = { length: extension.length, language: registration.language };
    }
  }

  return best?.language;
}

/** Return the highlight language for one path, or `"text"` when no grammar matches. */
export function fileLanguageForPath(path: string): SupportedLanguages {
  applyCurrentFileLanguages();
  const basename = basenameForLanguagePath(path);
  const registeredLanguage =
    extensionLanguage(basename, true) ??
    filenameLanguage(basename) ??
    globLanguage(path, basename) ??
    extensionLanguage(basename);

  if (registeredLanguage !== undefined) {
    return registeredLanguage as SupportedLanguages;
  }

  const inferred = getFiletypeFromFileName(path);
  return inferred === "text" && basename !== path ? getFiletypeFromFileName(basename) : inferred;
}
