import type { HunkConfigResolution } from "../core/config";
import { collectSessionCustomThemes } from "../core/customThemes";
import { loadAppBootstrap } from "../core/loaders";
import type { AppBootstrap, CliInput } from "../core/types";
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
  /** Abort a retired reload before its bootstrap is returned to the host. */
  signal?: AbortSignal;
  loadAppBootstrapImpl?: typeof loadAppBootstrap;
}

export interface SessionBootstrapResult {
  applied: AppliedExtensionRegistrations;
  bootstrap: AppBootstrap;
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
  signal,
  loadAppBootstrapImpl = loadAppBootstrap,
}: SessionBootstrapOptions): Promise<SessionBootstrapResult> {
  signal?.throwIfAborted();
  const sessionThemes = collectSessionCustomThemes(
    configured.customThemes,
    extensions?.registry.themes,
  );
  const applied = applyExtensionRegistrations(extensions);
  const sessionVcs = resolveSessionVcsId(configured.input.options.vcs, cwd, applied.vcsAdapters);
  let input = configured.input;

  if (sessionVcs.vcsId !== input.options.vcs) {
    input = { ...input, options: { ...input.options, vcs: sessionVcs.vcsId } };
  }

  const detectedVcsId = resolveDetectedVcsIdWithExtensions(
    cwd,
    applied.vcsAdapters,
    configured.explicitVcsId,
  );
  if (detectedVcsId !== undefined && detectedVcsId !== input.options.vcs) {
    input = { ...input, options: { ...input.options, vcs: detectedVcsId } };
  }

  const bootstrap = await loadAppBootstrapImpl(input, {
    ...(loadAtCwd ? { cwd } : {}),
    customThemes: sessionThemes.themes,
    vcsAdapters: applied.vcsAdapters,
    signal,
  });
  signal?.throwIfAborted();
  bootstrap.changeset = await applyExtensionChangesetTransforms(extensions, bootstrap.changeset);
  signal?.throwIfAborted();
  bootstrap.initialThemeMode = initialThemeMode ?? bootstrap.initialThemeMode;
  bootstrap.extensions = extensions;
  bootstrap.viewPreferencesConfigPath = configured.viewPreferencesConfigPath;
  bootstrap.keybindings = configured.keybindings;

  return { applied, bootstrap, input, sessionThemes, sessionVcs };
}
