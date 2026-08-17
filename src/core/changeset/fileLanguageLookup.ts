import {
  getFiletypeFromFileName,
  setCustomExtension,
  type SupportedLanguages,
} from "@pierre/diffs";
import { drainPendingFileLanguages } from "./fileLanguage";

/**
 * Resolves a path to a highlight language, applying deferred registrations first.
 *
 * This is the only module that reads or writes Pierre's process-global extension table, which
 * is what lets `fileLanguage` defer registrations: a mapping cannot be observed before it is
 * applied, because every read goes through here. Importing this module loads the diff engine,
 * so call it from changeset construction, never from startup.
 */

/** Push every queued mapping into Pierre's extension table. */
function applyPendingFileLanguages() {
  for (const [extension, language] of drainPendingFileLanguages()) {
    setCustomExtension(extension, language as SupportedLanguages);
  }
}

/** Return the highlight language for one path, or undefined when no grammar matches. */
export function fileLanguageForPath(path: string) {
  applyPendingFileLanguages();
  return getFiletypeFromFileName(path);
}
