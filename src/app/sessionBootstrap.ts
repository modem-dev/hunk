import {
  fileLanguageRegistrationSnapshot,
  restoreFileLanguageRegistrations,
  type FileLanguageRegistrationSnapshot,
} from "../core/changeset/fileLanguage";
import type { HunkConfigResolution } from "../core/run/config";
import { isVcsReviewInput } from "../core/vcs";
import type { VcsCatalog } from "../core/vcs/types";
import { getBundledVcsCatalog } from "./vcsCatalog";
import { collectSessionCustomThemes } from "../core/theme/customThemes";
import { loadAppBootstrap } from "../core/changeset/loaders";
import type { CliInput } from "../core/run/commandInputs";
import type { AppBootstrap } from "./types";
import {
  applyExtensionChangesetTransforms,
  applyExtensionRegistrations,
  resolveDetectedVcsIdWithExtensions,
  resolveSessionVcsId,
  type AppliedExtensionRegistrations,
} from "../extensions/apply";
import type { ExtensionLoadResult } from "../extensions/types";

export interface SessionBootstrapOptions {
  configured: HunkConfigResolution;
  cwd: string;
  extensions?: ExtensionLoadResult;
  initialThemeMode?: AppBootstrap["initialThemeMode"];
  /** Reloads can reopen another directory; initial launch relies on the loader's default cwd. */
  loadAtCwd?: boolean;
  loadAppBootstrapImpl?: typeof loadAppBootstrap;
  /** Base product adapters composed before user extensions are applied. */
  baseVcsCatalog?: VcsCatalog;
  /** Cancel initial provider-backed loading for an abandoned embedded surface. */
  signal?: AbortSignal;
}

export interface SessionBootstrapResult {
  applied: AppliedExtensionRegistrations;
  bootstrap: AppBootstrap;
  /** Selector set to restore if a live reload fails before its commit gate. */
  previousFileLanguages: FileLanguageRegistrationSnapshot;
  input: CliInput;
  sessionThemes: ReturnType<typeof collectSessionCustomThemes>;
  sessionVcs: ReturnType<typeof resolveSessionVcsId>;
}

/**
 * Build one review bootstrap after configuration and extension discovery have settled.
 *
 * First launch and live-session reloads both need this exact ordering: extensions register
 * adapters and themes, VCS selection is revisited with those adapters, then the normalized
 * changeset is loaded and transformed. Keeping it here prevents those paths from drifting.
 */
export async function loadConfiguredSessionBootstrap({
  configured,
  cwd,
  extensions,
  initialThemeMode,
  loadAtCwd = false,
  loadAppBootstrapImpl = loadAppBootstrap,
  baseVcsCatalog = getBundledVcsCatalog(),
  signal,
}: SessionBootstrapOptions): Promise<SessionBootstrapResult> {
  signal?.throwIfAborted();
  const previousFileLanguages = fileLanguageRegistrationSnapshot();

  try {
    const sessionThemes = collectSessionCustomThemes(
      configured.customThemes,
      extensions?.registry.themes,
    );
    const applied = applyExtensionRegistrations(extensions, baseVcsCatalog);
    const sessionVcs = resolveSessionVcsId(configured.input.options.vcs, cwd, applied.vcsCatalog);
    let input = configured.input;

    if (sessionVcs.vcsId !== input.options.vcs) {
      input = { ...input, options: { ...input.options, vcs: sessionVcs.vcsId } };
    }

    const detectedVcsId = isVcsReviewInput(input)
      ? resolveDetectedVcsIdWithExtensions(cwd, applied.vcsCatalog, configured.explicitVcsId)
      : undefined;
    if (detectedVcsId !== undefined && detectedVcsId !== input.options.vcs) {
      input = { ...input, options: { ...input.options, vcs: detectedVcsId } };
    }

    const bootstrap = (await loadAppBootstrapImpl(input, {
      ...(loadAtCwd ? { cwd } : {}),
      customThemes: sessionThemes.themes,
      vcsCatalog: applied.vcsCatalog,
      signal,
    })) as AppBootstrap;
    signal?.throwIfAborted();
    bootstrap.changeset = await applyExtensionChangesetTransforms(extensions, bootstrap.changeset);
    signal?.throwIfAborted();
    bootstrap.initialThemeMode = initialThemeMode ?? bootstrap.initialThemeMode;
    bootstrap.extensions = extensions;
    bootstrap.viewPreferencesConfigPath = configured.viewPreferencesConfigPath;
    bootstrap.keybindings = configured.keybindings;

    return { applied, bootstrap, input, previousFileLanguages, sessionThemes, sessionVcs };
  } catch (error) {
    restoreFileLanguageRegistrations(previousFileLanguages);
    throw error;
  }
}
