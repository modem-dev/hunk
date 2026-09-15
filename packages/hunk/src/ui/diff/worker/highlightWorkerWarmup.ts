/**
 * Starts the syntax worker and preloads a changeset's grammars before the review mounts.
 *
 * Warm-up is best-effort: failures are swallowed, and the first render request recreates the
 * worker or falls back inline exactly as it would without warm-up.
 */
import type { DiffFile } from "../../../core/changeset/model";
import type { SessionThemeInitialization } from "../../../core/session/initialization";
import { supportsHighlightWorkerOffload } from "../../../highlightWorkerClient";
import { resolveTheme, type AppTheme } from "../../themes";
import { syntaxHighlightThemeName, themeSupportsHighlightWorker } from "../syntaxHighlightTheme";
import { preloadHighlightWorker } from "./highlightWorkerClient";

/** Bounds worker CPU spent warming grammars that later files may never need. */
export const HIGHLIGHT_WARMUP_MAX_LANGUAGES = 8;

/** List distinct highlightable languages in review order, bounded for warm-up. */
export function highlightWarmupLanguages(files: readonly DiffFile[]) {
  const languages: string[] = [];
  for (const file of files) {
    if (file.isBinary || file.isTooLarge) continue;
    const language = file.language ?? "text";
    if (language === "text" || language === "ansi" || languages.includes(language)) continue;
    languages.push(language);
    if (languages.length >= HIGHLIGHT_WARMUP_MAX_LANGUAGES) break;
  }
  return languages;
}

/** Preload one grammar per message so a render request waits behind at most one warm-up. */
export function warmHighlightWorker(
  { files, theme }: { files: readonly DiffFile[]; theme: AppTheme },
  preload: typeof preloadHighlightWorker = preloadHighlightWorker,
) {
  if (!supportsHighlightWorkerOffload() || !themeSupportsHighlightWorker(theme)) return [];
  const languages = highlightWarmupLanguages(files);
  const syntaxTheme = syntaxHighlightThemeName(theme);
  for (const language of languages) {
    preload({ language, theme: syntaxTheme }).catch(() => {});
  }
  return languages;
}

/** Warm the worker for one launch using the theme the session host will resolve first. */
export function warmHighlightWorkerForLaunch(
  files: readonly DiffFile[],
  theme: SessionThemeInitialization,
) {
  return warmHighlightWorker({
    files,
    theme: resolveTheme(theme.initialTheme, theme.initialThemeMode ?? null, theme.customThemes),
  });
}
