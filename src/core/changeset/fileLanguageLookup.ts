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

/**
 * Return the highlight language for one path, or `"text"` when no grammar matches.
 *
 * Pierre keys extensionless names (`BUILD`, `Dockerfile`, `Makefile`) on the whole lookup string,
 * but Hunk looks up repo-relative paths, so a nested `pkg/BUILD` would otherwise render as plain
 * text while a root-level `BUILD` highlighted. Retrying on the basename is reachable only once
 * the full path has matched nothing, so a real extension still wins over a filename that merely
 * happens to appear deeper in the tree.
 */
export function fileLanguageForPath(path: string): SupportedLanguages {
  applyPendingFileLanguages();
  const language = getFiletypeFromFileName(path);
  if (language !== "text") {
    return language;
  }

  const basename = path.split(/[/\\]/).pop() ?? path;
  return basename === path ? language : getFiletypeFromFileName(basename);
}
